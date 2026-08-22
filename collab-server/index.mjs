#!/usr/bin/env node
// Entrypoint: configuration comes from the environment so the same code runs
// locally, in Docker, or behind a process manager. See .env.example.
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCollabServer } from './src/create-server.mjs';
import { createRestServer } from './src/rest.mjs';
import { readSecretSetting } from './src/secret-setting.mjs';

// Database files, journals and sidecars must start private even when the
// operator launches the bare-metal process under a permissive shell umask.
process.umask(0o077);

const DEFAULT_WS_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_WS_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_BEARER_TOKEN_BYTES = 4_096;
const MIN_PRODUCTION_SECRET_BYTES = 32;
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/u;
const SHUTDOWN_GRACE_MS = 25_000;

function hasAsciiControl(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Ports must fail loudly. A NaN reaches the listener as an invalid argument
 * and dies with a raw stack, which reads like a crash rather than a typo.
 *
 * @param {string | undefined} raw
 * @param {number} fallback
 * @param {string} name
 */
function portOf(raw, fallback, name) {
  if (raw === undefined || raw === '') return fallback;
  if (hasAsciiControl(raw) || Buffer.byteLength(raw, 'utf8') > 32) {
    console.error(`${name} is not a valid port setting.`);
    process.exit(1);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    console.error(`${name}="${raw}" is not a port number (0-65535).`);
    process.exit(1);
  }
  return value;
}

function configurationText(raw, fallback, name, maxBytes = 4_096) {
  const value = raw ?? fallback;
  if (value === '' || hasAsciiControl(value) || Buffer.byteLength(value, 'utf8') > maxBytes) {
    console.error(`${name} is not a valid configuration value.`);
    process.exit(1);
  }
  return value;
}

const port = portOf(process.env.PORT, 1234, 'PORT');
const database = configurationText(process.env.SQLITE_PATH, 'collab.sqlite', 'SQLITE_PATH');

// An unwritable database must fail startup, not stores. SQLite falls back
// to read-only on an existing file it cannot write, the process then looks
// healthy while every store cycle fails in the log, and the edits are gone
// on the next restart. The classic trigger is a Docker volume created by
// the older root image: the container now runs as the node user, and the
// one-time migration in the repository README (chown the volume to node)
// is the fix this message names.
if (database !== ':memory:') {
  const parent = dirname(database);
  try {
    const parentStat = statSync(parent);
    if (!parentStat.isDirectory()) throw new Error('database parent is not a directory');
    // SQLite needs to create journal/WAL side files beside even an existing
    // writable database, so checking the file alone is insufficient.
    accessSync(parent, constants.W_OK | constants.X_OK);
    if (existsSync(database)) {
      const databaseStat = statSync(database);
      if (!databaseStat.isFile()) throw new Error('database path is not a file');
      accessSync(database, constants.W_OK);
    }
  } catch {
    console.error(
      `SQLITE_PATH="${database}" is not writable by this process. If this is a Docker volume created by an older root-based image, run the one-time ownership migration from the README (chown the volume to the node user).`
    );
    process.exit(1);
  }
}

function secretSetting(name) {
  try {
    return readSecretSetting(process.env, name);
  } catch (error) {
    console.error(error instanceof Error ? error.message : `Could not read ${name}.`);
    process.exit(1);
  }
}

/** @param {string | undefined} raw */
function tokenSet(raw) {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean)
  );
}

function tokenSetIsHeaderSafe(value) {
  return [...value].every(
    (token) =>
      Buffer.byteLength(token, 'utf8') <= MAX_BEARER_TOKEN_BYTES && BEARER_TOKEN.test(token)
  );
}

const tokens = tokenSet(secretSetting('COLLAB_TOKENS'));
// Optional viewer tokens: connections authenticating with one of these get
// the document read-only, enforced server-side.
const readOnlyTokens = tokenSet(secretSetting('COLLAB_READONLY_TOKENS'));

if (tokens.size === 0) {
  console.error('Set COLLAB_TOKENS to at least one accepted token (comma separated).');
  process.exit(1);
}
if (!tokenSetIsHeaderSafe(tokens) || !tokenSetIsHeaderSafe(readOnlyTokens)) {
  console.error(
    `COLLAB_TOKENS and COLLAB_READONLY_TOKENS must contain only header-safe bearer tokens up to ${String(MAX_BEARER_TOKEN_BYTES)} bytes each.`
  );
  process.exit(1);
}

// A token in both lists resolves to read-only on both surfaces, but silently:
// the usual cause is demoting an editor to viewer and forgetting to remove the
// old entry, and the operator deserves to hear that the full-access listing is
// now dead weight rather than discover it during an incident.
const overlapping = [...tokens].filter((token) => readOnlyTokens.has(token));
if (overlapping.length > 0) {
  console.warn(
    `[collab] ${String(overlapping.length)} token(s) appear in both COLLAB_TOKENS and COLLAB_READONLY_TOKENS: they are treated as READ-ONLY. Remove them from COLLAB_TOKENS to make that explicit.`
  );
}

// Placeholder tokens exist so the first local run works without ceremony.
// In production the same convenience is a hole anyone can walk through, so
// the server refuses to start rather than warn into a log nobody reads.
const PLACEHOLDER_TOKENS = new Set(['change-me', 'change-me-too', 'dev-token', 'viewer-token']);
const production = process.env.NODE_ENV === 'production';
const webhookSecret = secretSetting('WEBHOOK_SECRET');
const placeholdersInUse = [...tokens, ...readOnlyTokens].filter((token) =>
  PLACEHOLDER_TOKENS.has(token)
);
// The webhook secret follows the same policy when webhooks are enabled: a
// signature key copied from the example file is forgeable by anyone who
// read that file, which defeats the signature entirely.
if (process.env.WEBHOOK_URL && PLACEHOLDER_TOKENS.has(webhookSecret)) {
  placeholdersInUse.push('WEBHOOK_SECRET');
}
if (placeholdersInUse.length > 0) {
  if (production) {
    console.error(
      `Refusing to start with placeholder tokens in production (${placeholdersInUse.join(', ')}). Set real secrets in COLLAB_TOKENS, COLLAB_READONLY_TOKENS and WEBHOOK_SECRET.`
    );
    process.exit(1);
  }
  console.warn(
    `[collab] Placeholder tokens in use (${placeholdersInUse.join(', ')}): fine locally, refused when NODE_ENV=production.`
  );
}

const weakSecretSettings = [];
if ([...tokens].some((token) => Buffer.byteLength(token, 'utf8') < MIN_PRODUCTION_SECRET_BYTES)) {
  weakSecretSettings.push('COLLAB_TOKENS');
}
if (
  [...readOnlyTokens].some(
    (token) => Buffer.byteLength(token, 'utf8') < MIN_PRODUCTION_SECRET_BYTES
  )
) {
  weakSecretSettings.push('COLLAB_READONLY_TOKENS');
}
if (
  process.env.WEBHOOK_URL &&
  webhookSecret &&
  Buffer.byteLength(webhookSecret, 'utf8') < MIN_PRODUCTION_SECRET_BYTES
) {
  weakSecretSettings.push('WEBHOOK_SECRET');
}
if (weakSecretSettings.length > 0) {
  const names = [...new Set(weakSecretSettings)].join(', ');
  if (production) {
    console.error(
      `Refusing production secrets shorter than ${String(MIN_PRODUCTION_SECRET_BYTES)} UTF-8 bytes (${names}). Generate independent random values; secret contents are never logged.`
    );
    process.exit(1);
  }
  console.warn(
    `[collab] ${names} contain secrets shorter than ${String(MIN_PRODUCTION_SECRET_BYTES)} bytes: fine only for local development.`
  );
}

// Optional webhook receiver for signed lifecycle events.
const webhook = process.env.WEBHOOK_URL
  ? { url: process.env.WEBHOOK_URL, secret: webhookSecret }
  : null;
if (webhook) {
  // A typo here would otherwise only surface at the first delivery, as a
  // warning in a log nobody is watching by then.
  try {
    const url = new URL(webhook.url);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== ''
    ) {
      throw new Error('unsupported webhook URL');
    }
    webhook.url = url.href;
  } catch {
    console.error('WEBHOOK_URL must be an HTTP(S) URL without credentials or a fragment.');
    process.exit(1);
  }
}
if (webhook && !webhook.secret) {
  // A forgotten secret must not fail silently: the operator believes these
  // deliveries are signed, and the receiver has no way to tell forgeries
  // apart from real events.
  if (production && process.env.WEBHOOK_ALLOW_UNSIGNED !== '1') {
    console.error(
      'Refusing to start unsigned webhooks in production. Set WEBHOOK_SECRET, or set WEBHOOK_ALLOW_UNSIGNED=1 only when authenticity is enforced elsewhere.'
    );
    process.exit(1);
  }
  console.warn(
    'WEBHOOK_URL is set without WEBHOOK_SECRET: deliveries go out UNSIGNED by explicit non-production or WEBHOOK_ALLOW_UNSIGNED configuration.'
  );
}
if (webhook && new URL(webhook.url).protocol === 'http:') {
  if (production && process.env.WEBHOOK_ALLOW_INSECURE_HTTP !== '1') {
    console.error(
      'Refusing an HTTP WEBHOOK_URL in production because event metadata and its signature would travel unencrypted. Use HTTPS, or set WEBHOOK_ALLOW_INSECURE_HTTP=1 only for a trusted private transport.'
    );
    process.exit(1);
  }
  console.warn(
    '[collab] WEBHOOK_URL uses unencrypted HTTP. Use HTTPS outside local or explicitly trusted private networks.'
  );
}

if (production && process.env.COLLAB_ALLOW_TOKEN_WIDE_DOCUMENT_ACCESS !== '1') {
  console.error(
    'Refusing the permissive authorizeDocument policy in production. Replace the callback for tenant-scoped access, or set COLLAB_ALLOW_TOKEN_WIDE_DOCUMENT_ACCESS=1 only for an intentionally single-team deployment.'
  );
  process.exit(1);
}
console.warn(
  '[collab] authorizeDocument is the permissive placeholder: any valid token can reach any document. Replace it in index.mjs before multi-tenant use.'
);

function positiveByteLimit(raw, fallback, name) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_WS_MAX_PAYLOAD_BYTES) {
    console.error(`${name} must be a whole number from 1 to ${String(MAX_WS_MAX_PAYLOAD_BYTES)}.`);
    process.exit(1);
  }
  return value;
}

const maxPayloadBytes = positiveByteLimit(
  process.env.WS_MAX_PAYLOAD_BYTES,
  DEFAULT_WS_MAX_PAYLOAD_BYTES,
  'WS_MAX_PAYLOAD_BYTES'
);

/**
 * The single per-document policy for both websocket and REST access. Replace
 * this permissive starter with the application's tenant/session lookup. It may
 * be asynchronous; both call sites await it and only literal true authorizes.
 */
async function authorizeDocument({ token, documentName, mode }) {
  void token;
  void documentName;
  void mode;
  return true;
}

// Hocuspocus binds ALL interfaces when no address is given, so the host is
// always passed, same posture as the REST API below: loopback by default,
// wider only when HOST says so deliberately (Docker sets 0.0.0.0).
const host = configurationText(process.env.HOST, '127.0.0.1', 'HOST', 1_024);
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
  console.warn(
    `[collab] Binding ${host}: make sure the server is reachable only from networks you trust.`
  );
}

/**
 * The listen promises never reject on socket errors, so without these
 * handlers a taken port or an unresolvable HOST dies with a raw stack
 * instead of a sentence, the exact failure portOf exists to prevent.
 * @param {NodeJS.ErrnoException} error
 */
function listenErrorText(error) {
  if (error.code === 'EADDRINUSE') return 'the port is already in use';
  if (error.code === 'EACCES') return 'ports below 1024 need elevated privileges';
  if (error.code === 'EADDRNOTAVAIL' || error.code === 'ENOTFOUND') {
    return 'the host address is not available on this machine';
  }
  return error.message;
}

const server = createCollabServer({
  port,
  host,
  tokens,
  database,
  readOnlyTokens,
  webhook,
  authorizeDocument,
  maxPayloadBytes,
});
server.httpServer.on('error', (error) => {
  console.error(`[collab] Could not listen on ${host}:${String(port)}: ${listenErrorText(error)}`);
  process.exit(1);
});
server.listen();

// Optional REST API on its own port, sharing the same Hocuspocus instance
// and persistence (see src/rest.mjs for the routes). Node binds ALL
// interfaces when no host is given, so the host is always passed: loopback
// by default, wider only when REST_HOST says so deliberately.
const restPort = portOf(process.env.REST_PORT, 0, 'REST_PORT');
if (restPort > 0 && restPort === port) {
  console.error(`REST_PORT (${String(restPort)}) must differ from PORT.`);
  process.exit(1);
}
const restHost =
  restPort > 0
    ? configurationText(process.env.REST_HOST, '127.0.0.1', 'REST_HOST', 1_024)
    : '127.0.0.1';
let rest = null;
if (restPort > 0) {
  if (restHost !== '127.0.0.1' && restHost !== 'localhost' && restHost !== '::1') {
    // Wide binding is legitimate (Docker needs it), but it must never be an
    // accident. The placeholder-token case needs no second check here: the
    // guard above already refused to start in production.
    console.warn(
      `[rest] Binding ${restHost}: make sure the API is reachable only from networks you trust.`
    );
  }
  rest = createRestServer({
    collabServer: server,
    tokens,
    readOnlyTokens,
    authorizeDocument,
  });
  rest.on('error', (error) => {
    console.error(
      `[rest] Could not listen on ${restHost}:${String(restPort)}: ${listenErrorText(error)}`
    );
    process.exit(1);
  });
  rest.listen(restPort, restHost, () => {
    console.log(`REST API listening on http://${restHost}:${String(restPort)}`);
  });
}

function closeHttpServer(httpServer) {
  if (!httpServer.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

let shutdownPromise = null;
function shutdown(signal) {
  if (shutdownPromise !== null) return shutdownPromise;
  shutdownPromise = (async () => {
    console.log(`[collab] ${signal} received; draining REST and flushing collaborative state.`);
    const forced = setTimeout(() => {
      console.error(
        `[collab] Graceful shutdown exceeded ${String(SHUTDOWN_GRACE_MS)} ms; forcing exit.`
      );
      rest?.closeAllConnections?.();
      server.httpServer.closeAllConnections?.();
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    try {
      // Stop new websocket upgrades immediately. Existing sessions stay alive
      // until REST requests drain, then destroy closes them and flushes every
      // pending debounced SQLite store before resolving.
      if (server.httpServer.listening) server.httpServer.close();
      if (rest !== null) await closeHttpServer(rest);
      await server.destroy();
      clearTimeout(forced);
      console.log('[collab] Graceful shutdown complete.');
      process.exit(0);
    } catch (error) {
      clearTimeout(forced);
      console.error('[collab] Graceful shutdown failed:', error?.message ?? String(error));
      process.exit(1);
    }
  })();
  return shutdownPromise;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

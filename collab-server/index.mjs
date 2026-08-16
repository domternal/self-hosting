#!/usr/bin/env node
// Entrypoint: configuration comes from the environment so the same code runs
// locally, in Docker, or behind a process manager. See .env.example.
import { createCollabServer } from './src/create-server.mjs';
import { createRestServer } from './src/rest.mjs';

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
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    console.error(`${name}="${raw}" is not a port number (0-65535).`);
    process.exit(1);
  }
  return value;
}

const port = portOf(process.env.PORT, 1234, 'PORT');
const database = process.env.SQLITE_PATH ?? 'collab.sqlite';

/** @param {string | undefined} raw */
function tokenSet(raw) {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean)
  );
}

const tokens = tokenSet(process.env.COLLAB_TOKENS);
// Optional viewer tokens: connections authenticating with one of these get
// the document read-only, enforced server-side.
const readOnlyTokens = tokenSet(process.env.COLLAB_READONLY_TOKENS);

if (tokens.size === 0) {
  console.error('Set COLLAB_TOKENS to at least one accepted token (comma separated).');
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
const placeholdersInUse = [...tokens, ...readOnlyTokens].filter((token) =>
  PLACEHOLDER_TOKENS.has(token)
);
// The webhook secret follows the same policy when webhooks are enabled: a
// signature key copied from the example file is forgeable by anyone who
// read that file, which defeats the signature entirely.
if (process.env.WEBHOOK_URL && PLACEHOLDER_TOKENS.has(process.env.WEBHOOK_SECRET ?? '')) {
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

// Optional webhook receiver for signed lifecycle events.
const webhook = process.env.WEBHOOK_URL
  ? { url: process.env.WEBHOOK_URL, secret: process.env.WEBHOOK_SECRET ?? '' }
  : null;
if (webhook) {
  // A typo here would otherwise only surface at the first delivery, as a
  // warning in a log nobody is watching by then.
  try {
    new URL(webhook.url);
  } catch {
    console.error(`WEBHOOK_URL="${webhook.url}" is not a valid URL.`);
    process.exit(1);
  }
}
if (webhook && !webhook.secret) {
  // A forgotten secret must not fail silently: the operator believes these
  // deliveries are signed, and the receiver has no way to tell forgeries
  // apart from real events.
  console.warn('WEBHOOK_URL is set without WEBHOOK_SECRET: deliveries go out UNSIGNED.');
}

// Hocuspocus binds ALL interfaces when no address is given, so the host is
// always passed, same posture as the REST API below: loopback by default,
// wider only when HOST says so deliberately (Docker sets 0.0.0.0).
const host = process.env.HOST ?? '127.0.0.1';
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

const server = createCollabServer({ port, host, tokens, database, readOnlyTokens, webhook });
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
const restHost = process.env.REST_HOST ?? '127.0.0.1';
if (restPort > 0) {
  if (restHost !== '127.0.0.1' && restHost !== 'localhost' && restHost !== '::1') {
    // Wide binding is legitimate (Docker needs it), but it must never be an
    // accident. The placeholder-token case needs no second check here: the
    // guard above already refused to start in production.
    console.warn(
      `[rest] Binding ${restHost}: make sure the API is reachable only from networks you trust.`
    );
  }
  const rest = createRestServer({ collabServer: server, tokens, readOnlyTokens });
  rest.on('error', (error) => {
    console.error(`[rest] Could not listen on ${restHost}:${String(restPort)}: ${listenErrorText(error)}`);
    process.exit(1);
  });
  rest.listen(restPort, restHost, () => {
    console.log(`REST API listening on http://${restHost}:${String(restPort)}`);
  });
}

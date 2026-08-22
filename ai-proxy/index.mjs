#!/usr/bin/env node
// Entrypoint: configuration comes from the environment so the same code runs
// locally, in Docker, or behind a process manager. See .env.example.
import { createAiProxy } from './src/create-proxy.mjs';
import { readSecretSetting } from './src/secret-setting.mjs';

const MAX_REQUEST_TIMEOUT_MS = 300_000;
const MAX_BEARER_TOKEN_BYTES = 4_096;
const MAX_PROVIDER_KEY_BYTES = 4_096;
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
 * Ports must fail loudly, same as in the collaboration server. A NaN
 * reaches the listener as an invalid argument and dies with a raw stack,
 * which reads like a crash rather than a typo.
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

function hostSetting(raw) {
  const value = raw ?? '127.0.0.1';
  if (value === '' || hasAsciiControl(value) || Buffer.byteLength(value, 'utf8') > 1_024) {
    console.error('HOST is not a valid configuration value.');
    process.exit(1);
  }
  return value;
}

const port = portOf(process.env.PORT, 1250, 'PORT');
const provider = process.env.PROVIDER ?? 'openai';

function secretSetting(name) {
  try {
    return readSecretSetting(process.env, name);
  } catch (error) {
    console.error(error instanceof Error ? error.message : `Could not read ${name}.`);
    process.exit(1);
  }
}

function httpEndpoint(raw, name) {
  if (raw === '') {
    console.error(
      'Set UPSTREAM_URL to the provider endpoint, e.g. https://api.openai.com/v1/chat/completions'
    );
    process.exit(1);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    console.error(`${name} must be a valid HTTP(S) URL.`);
    process.exit(1);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    console.error(`${name} must use http: or https:.`);
    process.exit(1);
  }
  if (url.username !== '' || url.password !== '') {
    console.error(`${name} must not contain URL credentials; use the dedicated key setting.`);
    process.exit(1);
  }
  if (url.hash !== '') {
    console.error(`${name} must not contain a URL fragment.`);
    process.exit(1);
  }
  return url;
}

const upstream = httpEndpoint(process.env.UPSTREAM_URL ?? '', 'UPSTREAM_URL');
const upstreamUrl = upstream.href;
const apiKey = secretSetting('PROVIDER_API_KEY');
if (Buffer.byteLength(apiKey, 'utf8') > MAX_PROVIDER_KEY_BYTES || hasAsciiControl(apiKey)) {
  console.error(
    `PROVIDER_API_KEY must be header-safe text up to ${String(MAX_PROVIDER_KEY_BYTES)} bytes; its value is never logged.`
  );
  process.exit(1);
}

/** @param {string | undefined} raw */
function tokenSet(raw) {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

const tokens = tokenSet(secretSetting('AI_TOKENS'));
if (
  [...tokens].some(
    (token) =>
      Buffer.byteLength(token, 'utf8') > MAX_BEARER_TOKEN_BYTES || !BEARER_TOKEN.test(token)
  )
) {
  console.error(
    `AI_TOKENS must contain only header-safe bearer tokens up to ${String(MAX_BEARER_TOKEN_BYTES)} bytes each; token values are never logged.`
  );
  process.exit(1);
}
const allowedOrigins = tokenSet(process.env.ALLOWED_ORIGINS);
for (const origin of allowedOrigins) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    console.error('Every ALLOWED_ORIGINS entry must be a canonical HTTP(S) origin.');
    process.exit(1);
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.origin !== origin
  ) {
    console.error('Every ALLOWED_ORIGINS entry must be a canonical HTTP(S) origin.');
    process.exit(1);
  }
}

if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'none') {
  console.error(`PROVIDER must be openai, anthropic or none, got "${provider}".`);
  process.exit(1);
}
const production = process.env.NODE_ENV === 'production';
if (apiKey === '' && provider !== 'none' && production) {
  console.error(
    'Refusing to start a hosted provider without PROVIDER_API_KEY in production. Set the key or use PROVIDER=none for a local model.'
  );
  process.exit(1);
}
if (apiKey === '' && provider !== 'none') {
  console.warn(
    '[ai-proxy] PROVIDER_API_KEY is empty: fine only for local models; hosted providers will reject the forwarded requests.'
  );
}
if (upstream.protocol === 'http:') {
  if (production && provider !== 'none' && process.env.UPSTREAM_ALLOW_INSECURE_HTTP !== '1') {
    console.error(
      'Refusing an HTTP UPSTREAM_URL for a hosted provider in production because the API key and prompts would travel unencrypted. Use HTTPS, or set UPSTREAM_ALLOW_INSECURE_HTTP=1 only for a trusted private transport.'
    );
    process.exit(1);
  }
  console.warn(
    '[ai-proxy] UPSTREAM_URL uses unencrypted HTTP. This is suitable only for a local model or explicitly trusted private transport.'
  );
}

// An unauthenticated proxy is an open relay burning YOUR provider budget
// for whoever finds the URL. Locally that is a warning; in production it
// refuses to start unless you explicitly accept it because authentication
// happens in a gateway in front of this process.
if (tokens.size === 0) {
  if (production && process.env.AI_ALLOW_UNAUTHENTICATED !== '1') {
    console.error(
      'Refusing to start without AI_TOKENS in production. Set caller tokens, or set AI_ALLOW_UNAUTHENTICATED=1 only when a gateway in front of this process authenticates every request.'
    );
    process.exit(1);
  }
  console.warn('[ai-proxy] No AI_TOKENS set: every caller is accepted. Do not expose this.');
}

// Same placeholder policy as the collaboration server: convenient locally,
// refused in production. 'dev' is here because earlier copies of the
// readme's local-models one-liner planted it, and values copied out of
// documentation are exactly what this guard exists to catch.
const PLACEHOLDER_TOKENS = new Set(['change-me', 'change-me-too', 'dev-token', 'dev']);
const placeholdersInUse = [...tokens].filter((token) => PLACEHOLDER_TOKENS.has(token));
if (placeholdersInUse.length > 0) {
  if (production) {
    console.error(
      `Refusing to start with placeholder tokens in production (${placeholdersInUse.join(', ')}). Set real secrets in AI_TOKENS.`
    );
    process.exit(1);
  }
  console.warn(
    `[ai-proxy] Placeholder tokens in use (${placeholdersInUse.join(', ')}): fine locally, refused when NODE_ENV=production.`
  );
}
if ([...tokens].some((token) => Buffer.byteLength(token, 'utf8') < MIN_PRODUCTION_SECRET_BYTES)) {
  if (production) {
    console.error(
      `Refusing AI_TOKENS shorter than ${String(MIN_PRODUCTION_SECRET_BYTES)} UTF-8 bytes in production. Generate random caller tokens; their values are never logged.`
    );
    process.exit(1);
  }
  console.warn(
    `[ai-proxy] AI_TOKENS contains values shorter than ${String(MIN_PRODUCTION_SECRET_BYTES)} bytes: fine only for local development.`
  );
}

// Node binds ALL interfaces when no host is given, so the host is always
// passed: loopback by default, wider only when HOST says so deliberately
// (Docker needs 0.0.0.0 for the port mapping to reach the process).
const host = hostSetting(process.env.HOST);
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
  console.warn(
    `[ai-proxy] Binding ${host}: make sure the proxy is reachable only from networks you trust.`
  );
}

// Total upstream cutoff per request. The default is generous for hosted
// providers; slow local models can need more than the 120 s default.
const timeoutSetting = process.env.REQUEST_TIMEOUT_MS ?? '';
const requestTimeoutMs = timeoutSetting === '' ? 120_000 : Number(timeoutSetting);
if (
  !Number.isSafeInteger(requestTimeoutMs) ||
  requestTimeoutMs < 1 ||
  requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
) {
  console.error(
    `REQUEST_TIMEOUT_MS must be a whole number from 1 to ${String(MAX_REQUEST_TIMEOUT_MS)}.`
  );
  process.exit(1);
}

const server = createAiProxy({
  upstreamUrl,
  provider,
  apiKey,
  tokens,
  allowedOrigins,
  requestTimeoutMs,
});
// The listen callback only fires on success; socket errors arrive on the
// 'error' event and would otherwise die with a raw stack, the exact
// failure every other misconfiguration in this file answers with a
// sentence.
server.on('error', (error) => {
  const text =
    error.code === 'EADDRINUSE'
      ? 'the port is already in use'
      : error.code === 'EACCES'
        ? 'ports below 1024 need elevated privileges'
        : error.code === 'EADDRNOTAVAIL' || error.code === 'ENOTFOUND'
          ? 'the host address is not available on this machine'
          : error.message;
  console.error(`[ai-proxy] Could not listen on ${host}:${String(port)}: ${text}`);
  process.exit(1);
});
server.listen(port, host, () => {
  // Query strings often carry gateway credentials. The configured endpoint
  // is used in full, but startup logs name only its origin.
  console.log(`AI proxy listening on http://${host}:${String(port)} -> ${upstream.origin}`);
});

let shutdownPromise = null;
function shutdown(signal) {
  if (shutdownPromise !== null) return shutdownPromise;
  shutdownPromise = new Promise((resolve) => {
    console.log(`[ai-proxy] ${signal} received; draining active requests.`);
    const forced = setTimeout(() => {
      console.error(
        `[ai-proxy] Graceful shutdown exceeded ${String(SHUTDOWN_GRACE_MS)} ms; forcing active connections closed.`
      );
      server.closeAllConnections();
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    if (!server.listening) {
      clearTimeout(forced);
      resolve();
      process.exit(0);
      return;
    }
    server.close((error) => {
      clearTimeout(forced);
      if (error) {
        console.error('[ai-proxy] Graceful shutdown failed:', error.message);
        resolve();
        process.exit(1);
        return;
      }
      console.log('[ai-proxy] Graceful shutdown complete.');
      resolve();
      process.exit(0);
    });
    server.closeIdleConnections();
  });
  return shutdownPromise;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

#!/usr/bin/env node
// Entrypoint: configuration comes from the environment so the same code runs
// locally, in Docker, or behind a process manager. See .env.example.
import { createAiProxy } from './src/create-proxy.mjs';

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
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    console.error(`${name}="${raw}" is not a port number (0-65535).`);
    process.exit(1);
  }
  return value;
}

const port = portOf(process.env.PORT, 1250, 'PORT');
const upstreamUrl = process.env.UPSTREAM_URL ?? '';
const provider = process.env.PROVIDER ?? 'openai';
const apiKey = process.env.PROVIDER_API_KEY ?? '';

/** @param {string | undefined} raw */
function tokenSet(raw) {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

const tokens = tokenSet(process.env.AI_TOKENS);
const allowedOrigins = tokenSet(process.env.ALLOWED_ORIGINS);

if (upstreamUrl === '') {
  console.error(
    'Set UPSTREAM_URL to the provider endpoint, e.g. https://api.openai.com/v1/chat/completions'
  );
  process.exit(1);
}
if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'none') {
  console.error(`PROVIDER must be openai, anthropic or none, got "${provider}".`);
  process.exit(1);
}
if (apiKey === '' && provider !== 'none') {
  console.warn(
    '[ai-proxy] PROVIDER_API_KEY is empty: fine only for local models; hosted providers will reject the forwarded requests.'
  );
}

const production = process.env.NODE_ENV === 'production';

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

// Node binds ALL interfaces when no host is given, so the host is always
// passed: loopback by default, wider only when HOST says so deliberately
// (Docker needs 0.0.0.0 for the port mapping to reach the process).
const host = process.env.HOST ?? '127.0.0.1';
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
  console.warn(
    `[ai-proxy] Binding ${host}: make sure the proxy is reachable only from networks you trust.`
  );
}

// Total upstream cutoff per request. The default is generous for hosted
// providers; slow local models can need more than the 120 s default.
const timeoutSet = (process.env.REQUEST_TIMEOUT_MS ?? '') !== '';
const timeoutRaw = Number(process.env.REQUEST_TIMEOUT_MS ?? '');
const timeoutValid = Number.isFinite(timeoutRaw) && timeoutRaw > 0;
if (timeoutSet && !timeoutValid) {
  // Every other misconfiguration in this file is loud; a silently ignored
  // timeout would look like it applied until a long generation got cut.
  console.warn(
    `[ai-proxy] REQUEST_TIMEOUT_MS="${process.env.REQUEST_TIMEOUT_MS}" is not a positive number: using the 120000 ms default.`
  );
}
const requestTimeoutMs = timeoutValid ? timeoutRaw : 120_000;
if (requestTimeoutMs > 300_000) {
  // Node's fetch (undici) cuts a request whose response headers or next
  // body chunk take longer than 300 s, regardless of this setting. The
  // value still bounds the total once data flows; only fully silent gaps
  // hit the runtime's own cap first.
  console.warn(
    `[ai-proxy] REQUEST_TIMEOUT_MS=${String(requestTimeoutMs)} exceeds Node's own 300 s silence cap: a stream that stays completely silent for longer than 300 s is still cut by the runtime. Pass a custom undici dispatcher to createAiProxy to raise that (see the readme).`
  );
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
  console.log(`AI proxy listening on http://${host}:${String(port)} -> ${upstreamUrl}`);
});

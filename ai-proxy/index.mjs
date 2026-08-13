#!/usr/bin/env node
// Entrypoint: configuration comes from the environment so the same code runs
// locally, in Docker, or behind a process manager. See .env.example.
import { createAiProxy } from './src/create-proxy.mjs';

const port = Number(process.env.PORT ?? '1250');
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
// refused in production.
const PLACEHOLDER_TOKENS = new Set(['change-me', 'change-me-too', 'dev-token']);
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
const timeoutRaw = Number(process.env.REQUEST_TIMEOUT_MS ?? '');
const requestTimeoutMs =
  Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 120_000;

const server = createAiProxy({
  upstreamUrl,
  provider,
  apiKey,
  tokens,
  allowedOrigins,
  requestTimeoutMs,
});
server.listen(port, host, () => {
  console.log(`AI proxy listening on http://${host}:${String(port)} -> ${upstreamUrl}`);
});

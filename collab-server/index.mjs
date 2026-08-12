#!/usr/bin/env node
// Entrypoint: configuration comes from the environment so the same code runs
// locally, in Docker, or behind a process manager. See .env.example.
import { createCollabServer } from './src/create-server.mjs';
import { createRestServer } from './src/rest.mjs';

const port = Number(process.env.PORT ?? '1234');
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

// Placeholder tokens exist so the first local run works without ceremony.
// In production the same convenience is a hole anyone can walk through, so
// the server refuses to start rather than warn into a log nobody reads.
const PLACEHOLDER_TOKENS = new Set(['change-me', 'change-me-too', 'dev-token', 'viewer-token']);
const production = process.env.NODE_ENV === 'production';
const placeholdersInUse = [...tokens, ...readOnlyTokens].filter((token) =>
  PLACEHOLDER_TOKENS.has(token)
);
if (placeholdersInUse.length > 0) {
  if (production) {
    console.error(
      `Refusing to start with placeholder tokens in production (${placeholdersInUse.join(', ')}). Set real secrets in COLLAB_TOKENS and COLLAB_READONLY_TOKENS.`
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
if (webhook && !webhook.secret) {
  // A forgotten secret must not fail silently: the operator believes these
  // deliveries are signed, and the receiver has no way to tell forgeries
  // apart from real events.
  console.warn('WEBHOOK_URL is set without WEBHOOK_SECRET: deliveries go out UNSIGNED.');
}

const server = createCollabServer({ port, tokens, database, readOnlyTokens, webhook });
server.listen();

// Optional REST API on its own port, sharing the same Hocuspocus instance
// and persistence (see src/rest.mjs for the routes). Node binds ALL
// interfaces when no host is given, so the host is always passed: loopback
// by default, wider only when REST_HOST says so deliberately.
const restPort = Number(process.env.REST_PORT ?? '0');
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
  rest.listen(restPort, restHost, () => {
    console.log(`REST API listening on http://${restHost}:${String(restPort)}`);
  });
}

#!/usr/bin/env node
// Entrypoint: configuration comes from the environment so the same code runs
// locally, in Docker, or behind a process manager. See .env.example.
import { createCollabServer } from './src/create-server.mjs';

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

// Optional webhook receiver for signed lifecycle events.
const webhook = process.env.WEBHOOK_URL
  ? { url: process.env.WEBHOOK_URL, secret: process.env.WEBHOOK_SECRET ?? '' }
  : null;

const server = createCollabServer({ port, tokens, database, readOnlyTokens, webhook });
server.listen();

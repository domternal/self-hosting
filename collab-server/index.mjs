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

if (tokens.size === 0) {
  console.error('Set COLLAB_TOKENS to at least one accepted token (comma separated).');
  process.exit(1);
}

const server = createCollabServer({ port, tokens, database });
server.listen();

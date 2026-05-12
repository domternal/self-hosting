// Reusable server factory. All configuration comes in as options (no
// process.env in here), so the same module can back the local entrypoint,
// tests, or a managed multi-tenant deployment.
import { Server } from '@hocuspocus/server';
import { SQLite } from '@hocuspocus/extension-sqlite';

/**
 * @param {object} options
 * @param {number} options.port
 * @param {Set<string>} options.tokens Accepted authentication tokens.
 * @param {string} options.database SQLite file path, or ':memory:' for tests.
 * @param {boolean} [options.quiet] Suppress the Hocuspocus start banner.
 */
export function createCollabServer({ port, tokens, database, quiet = false }) {
  return new Server({
    port,
    quiet,

    // Runs once per connecting client, before any document data flows.
    // Throwing rejects the connection and the client's provider fires
    // onAuthenticationFailed. Replace the Set lookup with your real check:
    // verify a JWT, hit your session table, and authorize `documentName`
    // (with tenant-scoped names such as "tenant-a/report-42" that is a
    // prefix comparison against the token's tenant).
    async onAuthenticate({ token, documentName }) {
      if (!tokens.has(token)) {
        throw new Error(`Invalid authentication token for "${documentName}"`);
      }
      // The return value becomes `context` in every later hook.
      return { token };
    },

    extensions: [new SQLite({ database })],
  });
}

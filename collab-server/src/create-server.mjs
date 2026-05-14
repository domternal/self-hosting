// Reusable server factory. All configuration comes in as options (no
// process.env in here), so the same module can back the local entrypoint,
// tests, or a managed multi-tenant deployment.
import { Server } from '@hocuspocus/server';
import { SQLite } from '@hocuspocus/extension-sqlite';
import * as Y from 'yjs';

// Matches DEFAULT_COLLAB_FIELD in @domternal-pro/extension-collaboration (the
// Collaboration extension's `field` default). If you change one side, change
// the other, and pass it explicitly to y-prosemirror helpers such as
// prosemirrorJSONToYDoc, whose own default is 'prosemirror'.
const COLLAB_FIELD = 'default';

/**
 * @param {object} options
 * @param {number} options.port
 * @param {Set<string>} options.tokens Accepted authentication tokens.
 * @param {string} options.database SQLite file path, or ':memory:' for tests.
 * @param {boolean} [options.quiet] Suppress the Hocuspocus start banner.
 * @param {(fragment: Y.XmlFragment, documentName: string) => void | null} [options.seed]
 *   Fills brand-new documents; pass null to disable seeding.
 */
export function createCollabServer({ port, tokens, database, quiet = false, seed = seedWelcome }) {
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

    // Runs after the SQLite extension restored any stored state, so an empty
    // fragment really is a brand-new document.
    async onLoadDocument({ document, documentName }) {
      const fragment = document.getXmlFragment(COLLAB_FIELD);
      if (seed && fragment.length === 0) {
        seed(fragment, documentName);
      }
      return document;
    },

    extensions: [new SQLite({ database })],
  });
}

/**
 * Default seed: builds initial content directly as Y.Xml nodes, which needs
 * no ProseMirror schema on the server. For rich templates convert ProseMirror
 * JSON instead, with y-prosemirror's prosemirrorJSONToYDoc(schema, json,
 * 'default'), using the schema from your editor bundle. Node and attribute
 * names must match your editor schema.
 */
export function seedWelcome(fragment) {
  const heading = new Y.XmlElement('heading');
  heading.setAttribute('level', 1);
  heading.insert(0, [new Y.XmlText('Welcome')]);
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText('This document was seeded by the server.')]);
  fragment.insert(0, [heading, paragraph]);
}

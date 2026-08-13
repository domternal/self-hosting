// Reusable server factory. All configuration comes in as options (no
// process.env in here), so the same module can back the local entrypoint,
// tests, or a managed multi-tenant deployment.
import { Server } from '@hocuspocus/server';
import { SQLite } from '@hocuspocus/extension-sqlite';
import { collectThreadGarbage } from '@domternal-pro/extension-comments/yjs';
import * as Y from 'yjs';
import { createWebhookNotifier } from './webhook.mjs';

// Matches DEFAULT_COLLAB_FIELD in @domternal-pro/extension-collaboration (the
// Collaboration extension's `field` default). If you change one side, change
// the other, and pass it explicitly to y-prosemirror helpers such as
// prosemirrorJSONToYDoc, whose own default is 'prosemirror'.
const COLLAB_FIELD = 'default';

// The Y.Map comment threads live in; must match the map handed to the
// client's YjsThreadStore (the playgrounds use ydoc.getMap('comments')).
const COMMENTS_MAP = 'comments';

/** @param {string} documentName */
function isVersionSibling(documentName) {
  return documentName.endsWith('-versions') || documentName.endsWith('/versions');
}

/**
 * @param {object} options
 * @param {number} options.port
 * @param {string} [options.host] Interface to bind; Hocuspocus binds all
 *   interfaces when this is omitted.
 * @param {Set<string>} options.tokens Accepted authentication tokens.
 * @param {string} options.database SQLite file path, or ':memory:' for tests.
 * @param {Set<string>} [options.readOnlyTokens] Tokens accepted for VIEWER
 *   connections: the document syncs down normally, and the server drops every
 *   DOCUMENT write coming back up this connection. Awareness (presence,
 *   cursors) stays two-way so viewers appear in presence.
 * @param {{ url: string, secret?: string } | null} [options.webhook] POSTs
 *   signed lifecycle events (document.changed, client.connected,
 *   client.disconnected) to your endpoint; null disables it.
 * @param {boolean} [options.quiet] Suppress the Hocuspocus start banner.
 * @param {(fragment: Y.XmlFragment, documentName: string) => void | null} [options.seed]
 *   Fills brand-new documents; pass null to disable seeding.
 */
export function createCollabServer({
  port,
  host,
  tokens,
  database,
  readOnlyTokens = new Set(),
  webhook = null,
  quiet = false,
  seed = seedWelcome,
}) {
  const notify = webhook ? createWebhookNotifier({ ...webhook, quiet }) : null;
  return new Server({
    port,
    address: host,
    quiet,

    // Runs once per connecting client, before any document data flows.
    // Throwing rejects the connection and the client's provider fires
    // onAuthenticationFailed. Replace the Set lookup with your real check:
    // verify a JWT, hit your session table, and authorize `documentName`
    // (with tenant-scoped names such as "tenant-a/report-42" that is a
    // prefix comparison against the token's tenant).
    async onAuthenticate({ token, documentName, connectionConfig }) {
      if (readOnlyTokens.has(token)) {
        // Server-enforced viewer role. `editable: false` on the client is a
        // courtesy for the UI; THIS line is the enforcement for the
        // DOCUMENT: Hocuspocus drops sync writes from a read-only
        // connection, so a tampered client cannot change content. Awareness
        // (presence, cursors) is NOT gated by it, deliberately here, since
        // viewers should appear in presence; a hostile viewer could abuse
        // that channel, which the client presence UI caps and sanitizes.
        connectionConfig.readOnly = true;
        return { token, readOnly: true };
      }
      if (!tokens.has(token)) {
        throw new Error(`Invalid authentication token for "${documentName}"`);
      }
      // The return value becomes `context` in every later hook.
      return { token };
    },

    // Runs after the SQLite extension restored any stored state, so an empty
    // fragment really is a brand-new document.
    async onLoadDocument({ document, documentName, context }) {
      // REST access opens direct connections with { rest: true } context.
      // A GET of a name nobody has opened yet must stay a read: seeding
      // here would let any read-only token materialize and persist welcome
      // content, and would let reads create documents. The websocket path
      // owns seeding.
      if (context?.rest === true) {
        return document;
      }
      // Sibling documents that carry version snapshots hold no prose; welcome
      // content in them would be junk next to the version data.
      if (isVersionSibling(documentName)) {
        return document;
      }
      const fragment = document.getXmlFragment(COLLAB_FIELD);
      if (seed && fragment.length === 0) {
        seed(fragment, documentName);
      }
      return document;
    },

    // Runs debounced after changes persist. Comment deletes under
    // collaboration are CRDT-safe tombstones (removing an entry outright on a
    // client would let a concurrent reply resurrect it); the server is the
    // one authority that may physically reclaim them, and this hook is where.
    // Without it, deleted threads accumulate in the document forever.
    async onStoreDocument({ document, documentName }) {
      if (!isVersionSibling(documentName)) {
        collectThreadGarbage(document.getMap(COMMENTS_MAP));
      }
      notify?.('document.changed', { documentName });
    },

    // NEVER forward `context` here: it holds the client's bearer token (the
    // onAuthenticate return value), and a webhook body is exactly the kind
    // of payload that ends up in third-party logs. Ship derived facts only.
    async connected({ documentName, context }) {
      notify?.('client.connected', { documentName, readOnly: context?.readOnly === true });
    },

    async onDisconnect({ documentName, context }) {
      notify?.('client.disconnected', { documentName, readOnly: context?.readOnly === true });
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

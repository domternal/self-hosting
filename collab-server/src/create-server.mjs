// Reusable server factory. All configuration comes in as options (no
// process.env in here), so the same module can back the local entrypoint,
// tests, or a managed multi-tenant deployment.
import { Server } from '@hocuspocus/server';
import { SQLite, upsertQuery } from '@hocuspocus/extension-sqlite';
import * as Y from 'yjs';
import { documentNameError } from './document-name.mjs';
import { createThreadGarbageCollector } from './thread-gc.mjs';
import { createWebhookNotifier } from './webhook.mjs';

// Matches DEFAULT_COLLAB_FIELD in the Domternal Pro Collaboration extension
// (the extension's `field` default). If you change one side, change
// the other, and pass it explicitly to y-prosemirror helpers such as
// prosemirrorJSONToYDoc, whose own default is 'prosemirror'.
const COLLAB_FIELD = 'default';

// The Y.Map comment threads live in; must match the map handed to the
// client's YjsThreadStore (the playgrounds use ydoc.getMap('comments')).
const COMMENTS_MAP = 'comments';

// Server-owned bookkeeping that rides along in the document. Only the seeded
// flag lives here today; the editor never reads this map. Exported because
// the REST API marks documents it provisions as owned (see rest.mjs).
export const META_MAP = 'serverMeta';

const DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/u;
const MAX_BEARER_TOKEN_BYTES = 4_096;

function validateTokenSet(value, name) {
  if (!(value instanceof Set)) throw new TypeError(`createCollabServer: ${name} must be a Set.`);
  for (const token of value) {
    if (
      typeof token !== 'string' ||
      token === '' ||
      Buffer.byteLength(token, 'utf8') > MAX_BEARER_TOKEN_BYTES ||
      !BEARER_TOKEN.test(token)
    ) {
      throw new TypeError(
        `createCollabServer: ${name} must contain only header-safe bearer tokens up to ${String(MAX_BEARER_TOKEN_BYTES)} bytes.`
      );
    }
  }
}

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
 * @param {(request: { token: string, documentName: string, mode: 'read' | 'write', surface: 'websocket' }) => boolean | Promise<boolean>} options.authorizeDocument
 *   Shared per-document policy; only literal true authorizes.
 * @param {number} [options.maxPayloadBytes] Maximum websocket frame size.
 * @param {((fragment: Y.XmlFragment, documentName: string) => void) | null} [options.seed]
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
  authorizeDocument,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
}) {
  validateTokenSet(tokens, 'tokens');
  validateTokenSet(readOnlyTokens, 'readOnlyTokens');
  if (typeof authorizeDocument !== 'function') {
    throw new TypeError('createCollabServer: authorizeDocument must be a function.');
  }
  if (
    !Number.isSafeInteger(maxPayloadBytes) ||
    maxPayloadBytes < 1 ||
    maxPayloadBytes > MAX_MAX_PAYLOAD_BYTES
  ) {
    throw new TypeError(
      `createCollabServer: maxPayloadBytes must be a whole number from 1 to ${String(MAX_MAX_PAYLOAD_BYTES)}.`
    );
  }
  const notify = webhook ? createWebhookNotifier({ ...webhook, quiet }) : null;
  const collectThreadGarbage = createThreadGarbageCollector();

  // Yjs updates applied to each live document since its last real store.
  // Closing a direct connection forces an IMMEDIATE store cycle that
  // replaces whatever store the editors' own edits had scheduled, and that
  // cycle carries the CLOSING connection's context. Skipping on context
  // alone would therefore let a REST read swallow pending editor work: the
  // scheduled store is canceled, nothing persists, and no webhook fires.
  // This ledger records whether real changes are waiting, so a read-context
  // store still persists and announces them.
  const pendingUpdates = new WeakMap();
  const observed = new WeakSet();
  /** @param {import('yjs').Doc} document */
  function observeUpdates(document) {
    if (observed.has(document)) return;
    observed.add(document);
    // Attached from onLoadDocument, which runs AFTER the persistence
    // extension restored stored state (extension hooks run before these
    // configuration-level hooks), so loading itself never counts.
    document.on('update', () => {
      pendingUpdates.set(document, (pendingUpdates.get(document) ?? 0) + 1);
    });
  }

  // Closing a direct connection always runs the store hooks, so a REST READ
  // of a name nobody has opened would persist an empty document, letting a
  // read-only token create rows at will. Reads mark their context and this
  // wrapper skips the write for them, unless the ledger above says editor
  // changes are riding on the same store cycle; REST writes persist
  // normally.
  const persistence = new SQLite({ database });
  const storeDocument = persistence.onStoreDocument?.bind(persistence);
  if (!storeDocument) {
    // Without the wrap, REST reads would quietly resume persisting empty
    // rows. A dependency upgrade must not remove that guarantee silently.
    throw new Error(
      '@hocuspocus/extension-sqlite no longer exposes onStoreDocument; update the REST read guard in create-server.mjs.'
    );
  }
  persistence.onStoreDocument = async (payload) => {
    const pending = pendingUpdates.get(payload.document) ?? 0;
    if (payload.lastContext?.restRead === true && pending === 0) return undefined;
    // The payload object is shared with the onStoreDocument hook below
    // (extensions run first, configuration hooks last), so this stamp is
    // how the notifier learns a read-context store carried real changes.
    payload.storedRealChanges = true;
    await storeDocument(payload);
    // Subtract only what this store captured: updates that landed while
    // the write ran stay counted for the next cycle.
    const remaining = (pendingUpdates.get(payload.document) ?? 0) - pending;
    if (remaining > 0) pendingUpdates.set(payload.document, remaining);
    else pendingUpdates.delete(payload.document);
  };

  // Neither the extension nor better-sqlite3 sets journal_mode, so the
  // connection would run the "delete" rollback journal, where SQLite restarts
  // an in-progress online backup on every write: the live backup OPERATIONS.md
  // documents could never converge on a busy server. The busy timeout is
  // pinned because WAL makes waiting load-bearing: a checkpoint meeting a
  // store cycle must wait, not fail with SQLITE_BUSY.
  const configure = persistence.onConfigure?.bind(persistence);
  if (!configure) {
    throw new Error(
      '@hocuspocus/extension-sqlite no longer exposes onConfigure; set journal_mode=WAL another way in create-server.mjs.'
    );
  }
  persistence.onConfigure = async (payload) => {
    await configure(payload);
    if (!persistence.db) {
      throw new Error(
        '@hocuspocus/extension-sqlite no longer exposes its database handle; set journal_mode=WAL another way in create-server.mjs.'
      );
    }
    // The switch is itself a write, so SQLITE_BUSY is possible while another
    // connection holds a read transaction, and that must not be fatal: the
    // server ran without WAL before. A filesystem that refuses WAL (many
    // network mounts do) keeps the old mode silently, so the mode actually in
    // force is read back either way and reported.
    let journalMode;
    try {
      persistence.db.pragma('busy_timeout = 5000');
      const [applied] = persistence.db.pragma('journal_mode = WAL');
      journalMode = applied?.journal_mode ?? null;
    } catch (error) {
      journalMode = `unavailable, ${error instanceof Error ? error.message : String(error)}`;
    }
    // An in-memory database has no journal to switch and is never the
    // subject of a backup.
    if (journalMode !== 'wal' && database !== ':memory:') {
      console.warn(
        `[collab] SQLite journal_mode is "${String(journalMode)}", not WAL: the online backup in OPERATIONS.md can restart indefinitely on a busy server. Put the database on a filesystem that supports WAL.`
      );
    }
  };

  /**
   * Persist a seed's CRDT identity before exposing it to the live document.
   * Build on a separate Y.Doc so beforeSync cannot broadcast uncommitted seed
   * updates to already-connected viewers. SQLite's synchronous write and the
   * live apply form one uninterrupted turn; a failed write leaves live state
   * untouched. Ordinary client edits retain their existing debounced stores.
   *
   * @param {import('yjs').Doc} document
   * @param {string} documentName
   * @param {object} context
   */
  function seedWritableDocument(document, documentName, context) {
    const meta = document.getMap(META_MAP);
    const fragment = document.getXmlFragment(COLLAB_FIELD);
    if (!seed || meta.get('seeded') === true || fragment.length !== 0) return false;
    if (!persistence.db) {
      throw new Error('Cannot seed a document before SQLite persistence is ready.');
    }
    const staged = new Y.Doc({ gc: document.gc });
    try {
      Y.applyUpdate(staged, Y.encodeStateAsUpdate(document));
      staged.transact(() => {
        seed(staged.getXmlFragment(COLLAB_FIELD), documentName);
        staged.getMap(META_MAP).set('seeded', true);
      });
      const update = Y.encodeStateAsUpdate(staged, Y.encodeStateVector(document));
      persistence.db.prepare(upsertQuery).run({
        name: documentName,
        data: Buffer.from(Y.encodeStateAsUpdate(staged)),
      });
      Y.applyUpdate(document, update, { source: 'local', context });
    } finally {
      staged.destroy();
    }
    return true;
  }

  return new Server({
    port,
    address: host,
    quiet,
    // A reusable factory must never install process-global signal handlers.
    // The executable entry point coordinates websocket, REST and persistence
    // shutdown together.
    stopOnSignals: false,
    websocketOptions: { maxPayload: maxPayloadBytes },

    // Runs once per connecting client, before any document data flows.
    // Throwing rejects the connection and the client's provider fires
    // onAuthenticationFailed. Replace the Set lookup with your real check:
    // verify a JWT, hit your session table, and authorize `documentName`
    // (with tenant-scoped names such as "tenant-a/report-42" that is a
    // prefix comparison against the token's tenant).
    async onAuthenticate({ token, documentName, connectionConfig }) {
      const invalidName = documentNameError(documentName);
      if (invalidName !== null) throw new Error(invalidName);
      let readOnly = false;
      if (readOnlyTokens.has(token)) {
        // Server-enforced viewer role. `editable: false` on the client is a
        // courtesy for the UI; THIS line is the enforcement for the
        // DOCUMENT: Hocuspocus drops sync writes from a read-only
        // connection, so a tampered client cannot change content. Awareness
        // (presence, cursors) is NOT gated by it, deliberately here, since
        // viewers should appear in presence; a hostile viewer could abuse
        // that channel, which the client presence UI caps and sanitizes.
        connectionConfig.readOnly = true;
        readOnly = true;
      } else if (!tokens.has(token)) {
        throw new Error(`Invalid authentication token for "${documentName}"`);
      }
      const authorized = await authorizeDocument({
        token,
        documentName,
        mode: readOnly ? 'read' : 'write',
        surface: 'websocket',
      });
      if (authorized !== true) {
        throw new Error(`Not authorized for document "${documentName}"`);
      }
      // Never retain the raw bearer token in long-lived hook context.
      return { readOnly };
    },

    // A document load is shared by every connection with the same name. If a
    // read-only client starts that load, onLoadDocument correctly leaves the
    // new document untouched, but it will not run again when a writer joins
    // while the viewer remains connected. Seed at the writer's first sync
    // boundary as well. Hocuspocus's update listener is already attached here,
    // so the staged seed must be committed before it reaches the live document
    // and can be broadcast to the viewer.
    async beforeSync({ document, documentName, context }) {
      if (context?.readOnly === true || isVersionSibling(documentName)) return;
      seedWritableDocument(document, documentName, context);
    },

    // Runs after the SQLite extension restored any stored state, so the
    // seeded flag below reflects what persistence actually holds.
    async onLoadDocument({ instance, document, documentName, context }) {
      // Track real changes from the first moment anything can write: the
      // restore is already applied by the time this hook runs, and clients
      // only start syncing after the load completes.
      observeUpdates(document);
      // REST access opens direct connections with { rest: true } context.
      // A GET of a name nobody has opened yet must stay a read: seeding
      // here would let any read-only token materialize and persist welcome
      // content, and would let reads create documents. The websocket path
      // owns seeding. Loads are shared: when a REST read starts the load and
      // a writer attaches to that live document, beforeSync claims and seeds
      // it before the writer's state exchange. Without a writer, the read
      // remains side-effect free.
      if (context?.rest === true) {
        return document;
      }
      // A read-only websocket connection must not create documents either:
      // onAuthenticate merges its return value into this context, and without
      // this branch a COLLAB_READONLY_TOKENS holder could open any unused
      // name and have the store cycle below write a row for it. If a writer
      // joins the shared live document, beforeSync claims and seeds it during
      // that writer's first sync; a viewer-only visit stays empty and unowned.
      if (context?.readOnly === true) {
        return document;
      }
      // Sibling documents that carry version snapshots hold no prose; welcome
      // content in them would be junk next to the version data.
      if (isVersionSibling(documentName)) {
        return document;
      }
      // Brand-new is a stored FLAG, not an empty fragment: a user who clears
      // the page on purpose also loads with a zero-length fragment, and a
      // length test alone would re-inject the welcome content they just
      // removed, then carry it into their exports, prints and version
      // snapshots. The emptiness test rides along as the second condition
      // for the opposite failure: a document whose first content arrived
      // through a path that forgot the flag must not get welcome content
      // injected on top of its real body.
      if (seedWritableDocument(document, documentName, context)) {
        // The seed is already durable. Hocuspocus attaches its update listener
        // after this hook, so explicitly schedule the normal store lifecycle
        // for post-store processing and change notifications as before.
        instance.storeDocumentHooks(document, {
          instance,
          document,
          documentName,
          clientsCount: 0,
          lastContext: context,
          lastTransactionOrigin: { source: 'local', context },
        });
      }
      return document;
    },

    // Runs debounced after changes persist. Comment deletes under
    // collaboration are CRDT-safe tombstones (removing an entry outright on a
    // client would let a concurrent reply resurrect it); the server is the
    // one authority that may physically reclaim them, and this hook is where.
    // Without it, deleted threads accumulate in the document forever.
    async onStoreDocument(payload) {
      const { document, documentName, lastContext } = payload;
      // Collect on every document. The suffix test that used to guard this
      // call classified by NAME alone, so a real document called
      // "handbook-versions" was never swept and kept deleted comment text in
      // storage forever. On a genuine snapshot sibling the sweep is a no-op.
      //
      // Never let this throw: the threads map is peer-writable, and an
      // exception here aborts the rest of the store hook, which strands
      // deleted bodies in persistence, stops webhook deliveries, pins the
      // document in memory and hangs graceful shutdown. The collector guards
      // its own shapes now, so this is the second line of defense.
      //
      // The sweep also runs on read-triggered cycles on purpose: when a
      // READ is what finally crosses a doomed thread's reclaim margin, the
      // reclamation is a real document change, so it persists through its
      // own follow-up store and announces one document.changed about two
      // seconds later. Skipping the sweep for reads would instead leave
      // tombstones in place forever on documents that are only ever read.
      try {
        collectThreadGarbage(document.getMap(COMMENTS_MAP), { scope: documentName });
      } catch (error) {
        console.error(`[collab] comment garbage collection failed for "${documentName}":`, error);
      }
      // A REST read opens a direct connection and closes it, which runs this
      // hook. Announcing a change nobody made would drive every receiver's
      // reindex and audit trail off pure reads. When the read-context store
      // absorbed real editor changes (the persistence wrap stamps the shared
      // payload), those changes DID happen and their announcement goes out.
      if (lastContext?.restRead === true && payload.storedRealChanges !== true) return;
      notify?.('document.changed', { documentName });
    },

    // NEVER forward `context` here: authentication deliberately keeps the
    // bearer token out of it, but integrations may add other private values
    // over time. A webhook body ends up in third-party logs, so ship only the
    // explicitly derived facts below.
    //
    // REST connections are skipped in both: there is no client, and reporting
    // one would put phantom sessions (with a meaningless readOnly flag) into
    // the receiver's stream on every API call.
    async connected({ documentName, context }) {
      if (context?.rest === true) return;
      notify?.('client.connected', { documentName, readOnly: context?.readOnly === true });
    },

    async onDisconnect({ documentName, context }) {
      if (context?.rest === true) return;
      notify?.('client.disconnected', { documentName, readOnly: context?.readOnly === true });
    },

    extensions: [persistence],
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

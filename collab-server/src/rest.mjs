// REST access to collaborative documents, riding the SAME Hocuspocus instance
// (openDirectConnection loads through the configured persistence, so it works
// with zero clients online and never forks state). Reads need no ProseMirror
// schema: yDocToProsemirrorJSON converts straight from the Y structure.
// Writes are CRDT-native: they accept a raw Yjs update, which merges cleanly
// into live sessions and works for every schema. Converting ProseMirror JSON
// into such an update needs your editor schema and belongs next to your
// editor bundle: build a Y.Doc with y-prosemirror's
// prosemirrorJSONToYDoc(schema, json, 'default') and POST its
// Y.encodeStateAsUpdate result here.
//
// MERGE, not replace: applying a fresh document's full state APPENDS its
// content next to whatever the document already holds (CRDT semantics; the
// fresh doc's structs carry new client ids). POSTing a whole new body onto a
// non-empty document duplicates it. To replace content, make the edit as an
// edit: load the current state, build the deletion + insertion against it,
// and POST the update encoded against that state vector.
import { createServer } from 'node:http';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';
import { META_MAP } from './create-server.mjs';

const COLLAB_FIELD = 'default';

// Request-body ceiling: one write-token holder must not be able to buffer
// the process into the ground. Far above any real document update.
const BODY_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * Per-document authorization, called on every route AFTER token
 * authentication. The example accepts everything, which means ANY valid
 * token can read and write ANY document name, version siblings included:
 * fine for a single-team deployment, wrong for multi-tenant. Replace with
 * your real check (with tenant-scoped names such as "tenant-a/report-42" it
 * is a prefix comparison against the token's tenant), and keep it in sync
 * with the same check in onAuthenticate on the websocket side.
 *
 * @param {string} token
 * @param {string} documentName
 * @param {'read' | 'write'} mode
 */
function authorizeDocument(token, documentName, mode) {
  void token;
  void documentName;
  void mode;
  return true;
}

/**
 * @param {object} options
 * @param {import('@hocuspocus/server').Server} options.collabServer
 * @param {Set<string>} options.tokens Full-access tokens (read + write).
 * @param {Set<string>} [options.readOnlyTokens] Tokens limited to GET routes.
 *
 * Routes (document names must be URL-encoded, e.g. tenant-a%2Freport-42):
 * - GET  /documents/{name}                        ProseMirror JSON
 * - GET  /documents/{name}/update                 full state as base64 Yjs update
 * - POST /documents/{name}/update  {"update"}     apply a base64 Yjs update
 * - GET  /documents/{name}/versions               version metadata list
 * - GET  /documents/{name}/versions/{id}/update   one version's snapshot as base64
 */
export function createRestServer({ collabServer, tokens, readOnlyTokens = new Set() }) {
  // Startup reminder that the placeholder above is in force. Delete this
  // warning together with the placeholder when you implement the real check.
  console.warn(
    '[rest] authorizeDocument is the permissive placeholder: any valid token can reach any document. Replace it in src/rest.mjs before multi-tenant use.'
  );

  /**
   * @param {string} name
   * @param {(doc: import('yjs').Doc) => unknown} read
   * @param {boolean} [mutates] Writers persist; readers must not. Closing a
   *   direct connection always runs the store hooks, so without this flag a
   *   GET of an unknown name would create and persist an empty document.
   */
  async function withDocument(name, read, mutates = false) {
    if (!mutates) {
      // A document that is open RIGHT NOW is read in place. A direct
      // connection would do more than read: closing it forces an immediate
      // store cycle that replaces the debounced store the editors' own
      // edits scheduled, so polling live documents would churn the
      // persistence layer for nothing. The documents map only ever holds
      // fully loaded documents, so an entry here is safe to read
      // synchronously; loads in flight take the connection path below.
      const live = collabServer.hocuspocus.documents.get(name);
      if (live) return read(live);
    }
    const connection = await collabServer.hocuspocus.openDirectConnection(name, {
      rest: true,
      restRead: !mutates,
    });
    try {
      let result;
      await connection.transact((document) => {
        result = read(document);
      });
      return result;
    } finally {
      // Always disconnect: an abandoned direct connection pins the document
      // in memory (the known Hocuspocus unload leak trigger).
      await connection.disconnect();
    }
  }

  /** @param {import('node:http').ServerResponse} res */
  function json(res, status, body, extraHeaders = {}) {
    // The 413 path destroys the request socket mid-stream; writing headers
    // onto that dead socket would throw inside the error handler itself.
    if (res.destroyed || res.writableEnded || res.headersSent) return;
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
    res.end(payload);
  }

  /** @param {import('node:http').IncomingMessage} req */
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let received = 0;
      req.on('data', (chunk) => {
        received += chunk.length;
        if (received > BODY_LIMIT_BYTES) {
          const error = new Error('Request body too large');
          error.statusCode = 413;
          req.destroy(error);
          reject(error);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', reject);
    });
  }

  return createServer((req, res) => {
    void (async () => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const canRead = tokens.has(token) || readOnlyTokens.has(token);
      // Read-only wins when a token appears in both sets, matching
      // onAuthenticate on the websocket side. Without this the two surfaces
      // disagree, and an operator who demotes an editor by adding their token
      // to the viewer list (without removing it from the full list) leaves
      // them full write access here while the editor UI goes read-only.
      const canWrite = tokens.has(token) && !readOnlyTokens.has(token);
      if (!canRead) {
        json(res, 401, { error: 'Missing or invalid bearer token' }, { 'www-authenticate': 'Bearer' });
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      // Malformed percent-encoding is the caller's error: the URIError from
      // decodeURIComponent must answer 400, not fall through as a 500.
      let segments;
      try {
        segments = url.pathname.split('/').slice(1).map(decodeURIComponent);
      } catch {
        json(res, 400, { error: 'Path is not valid percent-encoding' });
        return;
      }
      // Tolerate one canonical trailing slash, nothing more. Collapsing ALL
      // empty segments would misroute /documents//update (an empty name
      // interpolated by the caller) onto a document literally named
      // "update"; the empty name must reach the guard below instead.
      if (segments.length > 1 && segments[segments.length - 1] === '') {
        segments.pop();
      }
      if (segments[0] !== 'documents' || segments.length < 2) {
        json(res, 404, { error: 'Unknown route' });
        return;
      }
      const name = segments[1];
      if (name.trim() === '') {
        // Hocuspocus refuses empty names with a throw; answer the caller
        // before the library turns that into a 500.
        json(res, 400, { error: 'Document name must not be empty' });
        return;
      }
      const rest = segments.slice(2);
      const mode = req.method === 'POST' ? 'write' : 'read';
      if (!authorizeDocument(token, name, mode)) {
        json(res, 403, { error: `Not authorized for document "${name}"` });
        return;
      }

      // GET /documents/{name}
      if (rest.length === 0 && req.method === 'GET') {
        const content = await withDocument(name, (document) =>
          yDocToProsemirrorJSON(document, COLLAB_FIELD)
        );
        json(res, 200, { name, content });
        return;
      }

      // /documents/{name}/update
      if (rest.length === 1 && rest[0] === 'update') {
        if (req.method === 'GET') {
          const update = await withDocument(name, (document) =>
            Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64')
          );
          json(res, 200, { name, update });
          return;
        }
        if (req.method === 'POST') {
          if (!canWrite) {
            json(res, 403, { error: 'Read-only token' });
            return;
          }
          // Malformed input is the CALLER's error, so it must not fall
          // through to the 500 handler: that would answer a bad request with
          // a server error and leak the parser's internals in the body.
          let body;
          try {
            body = JSON.parse((await readBody(req)) || '{}');
          } catch {
            json(res, 400, { error: 'Body must be valid JSON' });
            return;
          }
          if (typeof body.update !== 'string') {
            json(res, 400, { error: 'Body must be {"update": "<base64 Yjs update>"}' });
            return;
          }
          const update = Buffer.from(body.update, 'base64');
          // Decode against a scratch document first: Y.applyUpdate
          // integrates structs AS it decodes, so a corrupt update applied
          // straight to the live document could mutate it partially before
          // throwing. The caller's error must be refused with zero side
          // effects, and a genuine server fault below must stay a 500
          // instead of masquerading as a 400. The write path deliberately
          // pays about twice the update's integration cost for this; the
          // body cap above bounds the worst case.
          try {
            Y.applyUpdate(new Y.Doc(), update);
          } catch {
            // Yjs throws its own internal errors on a corrupt update; those
            // messages describe our dependency, not the caller's mistake.
            json(res, 400, { error: 'Body is not a decodable Yjs update' });
            return;
          }
          await withDocument(
            name,
            (document) => {
              // No custom origin: this runs inside connection.transact, whose
              // already-open transaction (origin { source: 'local' }) absorbs
              // the apply, so a third argument here would be silently ignored.
              // Distinguish REST writes by the direct connection's context
              // ({ rest: true }, see withDocument) in your hooks instead.
              Y.applyUpdate(document, update);
              // Content that arrives through this path was never seeded and
              // must never be: mark the document as owned so the websocket
              // load does not inject welcome content on top of it. Guarded,
              // because Y.Map.set writes a fresh struct even for an equal
              // value: unguarded, a byte-identical replayed POST (which the
              // apply above no-ops) would still dirty the document and
              // announce a change that did not happen.
              const meta = document.getMap(META_MAP);
              if (meta.get('seeded') !== true) meta.set('seeded', true);
            },
            true
          );
          json(res, 200, { name, applied: true });
          return;
        }
      }

      // Version snapshots live in the sibling document the version store
      // syncs under a derived name; entries are Y.Maps holding metadata plus
      // the full-state blob captured at save time.
      if (rest[0] === 'versions' && req.method === 'GET') {
        const versionsDoc = `${name}-versions`;

        // GET /documents/{name}/versions
        if (rest.length === 1) {
          const versions = await withDocument(versionsDoc, (document) =>
            document
              .getArray('versions')
              .toArray()
              // The sibling document is peer-writable: one client writing a
              // plain value into the array must not turn the whole listing
              // into a 500 for every caller.
              .filter((entry) => entry instanceof Y.Map)
              .map((entry) => ({
                id: entry.get('id'),
                name: entry.get('name'),
                createdAt: entry.get('createdAt'),
                authors: entry.get('authors'),
                trigger: entry.get('trigger'),
                restoredFrom: entry.get('restoredFrom'),
                metadata: entry.get('metadata'),
              }))
          );
          json(res, 200, { name, versions });
          return;
        }

        // GET /documents/{name}/versions/{id}/update
        // The raw Yjs binary of one version: feed it to Y.applyUpdate on an
        // empty Y.Doc client-side to materialize, diff or export that state.
        if (rest.length === 3 && rest[2] === 'update') {
          const versionId = rest[1];
          const update = await withDocument(versionsDoc, (document) => {
            const entry = document
              .getArray('versions')
              .toArray()
              .find((candidate) => candidate instanceof Y.Map && candidate.get('id') === versionId);
            const blob = entry?.get('blob');
            return blob ? Buffer.from(blob).toString('base64') : null;
          });
          if (update === null) {
            json(res, 404, { error: `Unknown version "${versionId}"` });
            return;
          }
          json(res, 200, { name, versionId, update });
          return;
        }
      }

      json(res, 404, { error: 'Unknown route' });
    })().catch((error) => {
      const status = typeof error?.statusCode === 'number' ? error.statusCode : 500;
      // Errors minted in this file carry a statusCode and describe the
      // caller's mistake, so their message passes through. Anything else is
      // ours: log it for the operator and keep library internals (SQLite,
      // Hocuspocus, Yjs) out of the response body.
      if (status >= 500) {
        console.error(`[rest] ${req.method ?? ''} ${req.url ?? ''} failed:`, error);
        json(res, status, { error: 'Internal server error' });
        return;
      }
      json(res, status, { error: error instanceof Error ? error.message : String(error) });
    });
  });
}

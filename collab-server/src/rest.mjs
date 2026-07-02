// REST access to collaborative documents, riding the SAME Hocuspocus instance
// (openDirectConnection loads through the configured persistence, so it works
// with zero clients online and never forks state). Reads need no ProseMirror
// schema: yDocToProsemirrorJSON converts straight from the Y structure.
import { createServer } from 'node:http';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';

const COLLAB_FIELD = 'default';

/**
 * Per-document authorization, called on every route AFTER token
 * authentication. The example accepts everything, which means ANY valid
 * token can read ANY document name: fine for a single-team deployment,
 * wrong for multi-tenant. Replace with your real check (with tenant-scoped
 * names such as "tenant-a/report-42" it is a prefix comparison against the
 * token's tenant), and keep it in sync with the same check in
 * onAuthenticate on the websocket side.
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
 * @param {Set<string>} options.tokens Accepted tokens.
 * @param {Set<string>} [options.readOnlyTokens] Viewer tokens, also accepted.
 *
 * Routes (document names must be URL-encoded, e.g. tenant-a%2Freport-42):
 * - GET  /documents/{name}          ProseMirror JSON
 * - GET  /documents/{name}/update   full state as base64 Yjs update
 */
export function createRestServer({ collabServer, tokens, readOnlyTokens = new Set() }) {
  /** @param {string} name @param {(doc: import('yjs').Doc) => unknown} read */
  async function withDocument(name, read) {
    const connection = await collabServer.hocuspocus.openDirectConnection(name, { rest: true });
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
  function json(res, status, body) {
    if (res.destroyed || res.writableEnded || res.headersSent) return;
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(payload);
  }

  return createServer((req, res) => {
    void (async () => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const canRead = tokens.has(token) || readOnlyTokens.has(token);
      if (!canRead) {
        json(res, 401, { error: 'Missing or invalid bearer token' });
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (segments[0] !== 'documents' || segments.length < 2) {
        json(res, 404, { error: 'Unknown route' });
        return;
      }
      const name = segments[1];
      const rest = segments.slice(2);
      if (!authorizeDocument(token, name, 'read')) {
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

      // GET /documents/{name}/update
      if (rest.length === 1 && rest[0] === 'update' && req.method === 'GET') {
        const update = await withDocument(name, (document) =>
          Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64')
        );
        json(res, 200, { name, update });
        return;
      }

      json(res, 404, { error: 'Unknown route' });
    })().catch((error) => {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
}

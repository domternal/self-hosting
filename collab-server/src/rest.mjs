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
import { documentNameError } from './document-name.mjs';

const COLLAB_FIELD = 'default';

// Request-body ceiling: one write-token holder must not be able to buffer
// the process into the ground. Far above any real document update.
const BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const BODY_IDLE_MS = 20_000;
const MAX_VERSION_ENTRIES = 1_000;
const MAX_VERSION_SCAN_ENTRIES = 5_000;
const MAX_VERSION_LIST_BYTES = 4 * 1024 * 1024;
const MAX_VERSION_BLOB_BYTES = 32 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_METADATA_NODES = 1_000;
const MAX_METADATA_DEPTH = 8;
const INVALID_JSON_VALUE = Symbol('invalid-json-value');
const VERSION_TRIGGERS = new Set(['manual', 'auto', 'restore-backup', 'restore']);
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/u;
const MAX_BEARER_TOKEN_BYTES = 4_096;
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function validateTokenSet(value, name) {
  if (!(value instanceof Set)) throw new TypeError(`createRestServer: ${name} must be a Set.`);
  for (const token of value) {
    if (
      typeof token !== 'string' ||
      token === '' ||
      Buffer.byteLength(token, 'utf8') > MAX_BEARER_TOKEN_BYTES ||
      !BEARER_TOKEN.test(token)
    ) {
      throw new TypeError(
        `createRestServer: ${name} must contain only header-safe bearer tokens up to ${String(MAX_BEARER_TOKEN_BYTES)} bytes.`
      );
    }
  }
}

function bearerToken(req) {
  const distinct = req.headersDistinct?.authorization;
  if (distinct !== undefined && distinct.length !== 1) return null;
  const header = distinct?.[0] ?? req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/iu.exec(header);
  return match?.[1] ?? null;
}

function jsonSafeValue(value, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_METADATA_NODES || depth > MAX_METADATA_DEPTH) {
    return INVALID_JSON_VALUE;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID_JSON_VALUE;
  if (typeof value === 'string') {
    state.bytes += Buffer.byteLength(value, 'utf8');
    return state.bytes <= MAX_METADATA_BYTES ? value : INVALID_JSON_VALUE;
  }
  if (typeof value !== 'object' || state.seen.has(value)) return INVALID_JSON_VALUE;
  state.seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_NODES) return INVALID_JSON_VALUE;
    const output = [];
    for (const item of value) {
      const safe = jsonSafeValue(item, state, depth + 1);
      if (safe === INVALID_JSON_VALUE) return INVALID_JSON_VALUE;
      output.push(safe);
    }
    state.seen.delete(value);
    return output;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return INVALID_JSON_VALUE;
  const output = Object.create(null);
  let properties = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    properties += 1;
    if (properties > MAX_METADATA_NODES) return INVALID_JSON_VALUE;
    state.bytes += Buffer.byteLength(key, 'utf8');
    if (state.bytes > MAX_METADATA_BYTES) return INVALID_JSON_VALUE;
    const safe = jsonSafeValue(value[key], state, depth + 1);
    if (safe === INVALID_JSON_VALUE) return INVALID_JSON_VALUE;
    output[key] = safe;
  }
  state.seen.delete(value);
  return output;
}

function boundedString(value, maxBytes) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes ? value : null;
}

function uncheckedVersionEntry(entry, index) {
  if (!(entry instanceof Y.Map)) return null;
  const id = boundedString(entry.get('id'), 512);
  const createdAt = entry.get('createdAt');
  if (id === null || id === '' || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    return null;
  }
  const rawAuthors = entry.get('authors');
  const authors = Array.isArray(rawAuthors)
    ? rawAuthors
        .slice(0, 100)
        .map((author) => boundedString(author, 512))
        .filter((author) => author !== null)
    : [];
  const rawMetadata = entry.get('metadata');
  let metadata = null;
  if (rawMetadata !== null && rawMetadata !== undefined) {
    const safe = jsonSafeValue(rawMetadata, { bytes: 0, nodes: 0, seen: new WeakSet() });
    if (safe !== INVALID_JSON_VALUE && !Array.isArray(safe) && typeof safe === 'object') {
      const encoded = JSON.stringify(safe);
      if (Buffer.byteLength(encoded, 'utf8') <= MAX_METADATA_BYTES) metadata = safe;
    }
  }
  const trigger = entry.get('trigger');
  return {
    index,
    value: {
      id,
      name: boundedString(entry.get('name'), 4_096),
      createdAt,
      authors,
      trigger: VERSION_TRIGGERS.has(trigger) ? trigger : 'auto',
      restoredFrom: boundedString(entry.get('restoredFrom'), 512),
      metadata,
    },
  };
}

function safeVersionEntry(entry, index) {
  try {
    return uncheckedVersionEntry(entry, index);
  } catch {
    // Version metadata is collaborative input. One hostile or simply old
    // entry must never turn the complete listing into a 500 response.
    return null;
  }
}

function versionSortKey(entry, index) {
  try {
    if (!(entry instanceof Y.Map)) return null;
    const id = boundedString(entry.get('id'), 512);
    const createdAt = entry.get('createdAt');
    if (id === null || id === '' || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
      return null;
    }
    return { entry, index, createdAt };
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {import('@hocuspocus/server').Server} options.collabServer
 * @param {Set<string>} options.tokens Full-access tokens (read + write).
 * @param {Set<string>} [options.readOnlyTokens] Tokens limited to GET routes.
 * @param {(request: { token: string, documentName: string, mode: 'read' | 'write', surface: 'rest' }) => boolean | Promise<boolean>} options.authorizeDocument
 *
 * Routes (document names must be URL-encoded, e.g. tenant-a%2Freport-42):
 * - GET  /documents/{name}                        ProseMirror JSON
 * - GET  /documents/{name}/update                 full state as base64 Yjs update
 * - POST /documents/{name}/update  {"update"}     apply a base64 Yjs update
 * - GET  /documents/{name}/versions               version metadata list
 * - GET  /documents/{name}/versions/{id}/update   one version's snapshot as base64
 */
export function createRestServer({
  collabServer,
  tokens,
  readOnlyTokens = new Set(),
  authorizeDocument,
}) {
  validateTokenSet(tokens, 'tokens');
  validateTokenSet(readOnlyTokens, 'readOnlyTokens');
  if (typeof authorizeDocument !== 'function') {
    throw new TypeError('createRestServer: authorizeDocument must be a function.');
  }

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
    res.writeHead(status, {
      'content-type': 'application/json',
      ...extraHeaders,
      ...SECURITY_HEADERS,
    });
    res.end(payload);
  }

  /** @param {import('node:http').IncomingMessage} req */
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let received = 0;
      let finished = false;
      let idle;
      const settle = () => {
        clearTimeout(idle);
      };
      const fail = (error) => {
        if (finished) return;
        finished = true;
        settle();
        req.destroy(error);
        reject(error);
      };
      const arm = () => {
        idle = setTimeout(() => {
          const error = new Error('Request body stalled');
          error.statusCode = 408;
          fail(error);
        }, BODY_IDLE_MS);
        idle.unref();
      };
      arm();
      req.on('data', (chunk) => {
        if (finished) return;
        settle();
        arm();
        received += chunk.length;
        if (received > BODY_LIMIT_BYTES) {
          const error = new Error('Request body too large');
          error.statusCode = 413;
          fail(error);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (finished) return;
        finished = true;
        settle();
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', (error) => {
        if (finished) return;
        finished = true;
        settle();
        reject(error);
      });
      req.on('close', () => {
        if (finished) return;
        finished = true;
        settle();
        reject(new Error('Request body closed before completion'));
      });
    });
  }

  return createServer((req, res) => {
    void (async () => {
      const token = bearerToken(req);
      const canRead = token !== null && (tokens.has(token) || readOnlyTokens.has(token));
      // Read-only wins when a token appears in both sets, matching
      // onAuthenticate on the websocket side. Without this the two surfaces
      // disagree, and an operator who demotes an editor by adding their token
      // to the viewer list (without removing it from the full list) leaves
      // them full write access here while the editor UI goes read-only.
      const canWrite = token !== null && tokens.has(token) && !readOnlyTokens.has(token);
      if (!canRead) {
        json(
          res,
          401,
          { error: 'Missing or invalid bearer token' },
          { 'www-authenticate': 'Bearer' }
        );
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
      const invalidName = documentNameError(name);
      if (invalidName !== null) {
        // Refuse invalid storage keys before authorization, persistence or
        // logging can retain control characters or ambiguous Unicode forms.
        json(res, 400, { error: invalidName });
        return;
      }
      const rest = segments.slice(2);
      const mode = req.method === 'POST' ? 'write' : 'read';
      if (
        (await authorizeDocument({ token, documentName: name, mode, surface: 'rest' })) !== true
      ) {
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
          const versions = await withDocument(versionsDoc, (document) => {
            const source = document.getArray('versions');
            const start = Math.max(0, source.length - MAX_VERSION_SCAN_ENTRIES);
            const candidates = [];
            for (let index = start; index < source.length; index += 1) {
              const candidate = versionSortKey(source.get(index), index);
              if (candidate !== null) candidates.push(candidate);
            }
            candidates.sort(
              (left, right) => right.createdAt - left.createdAt || right.index - left.index
            );
            const versions = [];
            let responseBytes = 0;
            for (const candidate of candidates) {
              const safe = safeVersionEntry(candidate.entry, candidate.index);
              if (safe === null) continue;
              const bytes = Buffer.byteLength(JSON.stringify(safe.value), 'utf8');
              if (responseBytes + bytes > MAX_VERSION_LIST_BYTES) break;
              versions.push(safe.value);
              responseBytes += bytes;
              if (versions.length >= MAX_VERSION_ENTRIES) break;
            }
            return versions;
          });
          json(res, 200, { name, versions });
          return;
        }

        // GET /documents/{name}/versions/{id}/update
        // The raw Yjs binary of one version: feed it to Y.applyUpdate on an
        // empty Y.Doc client-side to materialize, diff or export that state.
        if (rest.length === 3 && rest[2] === 'update') {
          const versionId = rest[1];
          const update = await withDocument(versionsDoc, (document) => {
            const source = document.getArray('versions');
            const start = Math.max(0, source.length - MAX_VERSION_SCAN_ENTRIES);
            for (let index = source.length - 1; index >= start; index -= 1) {
              try {
                const entry = source.get(index);
                if (!(entry instanceof Y.Map) || entry.get('id') !== versionId) continue;
                const blob = entry.get('blob');
                return blob instanceof Uint8Array && blob.byteLength <= MAX_VERSION_BLOB_BYTES
                  ? Buffer.from(blob).toString('base64')
                  : null;
              } catch {
                return null;
              }
            }
            return null;
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

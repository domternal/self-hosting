# Reference collaboration server

A minimal, production-shaped [Hocuspocus](https://hocuspocus.dev) v4 server for Domternal Pro. One server backs three features: real-time collaboration syncs through it, [version history](https://domternal.dev/v1/pro/version-history/) keeps its snapshots on it in sibling documents, and comment threads live inside the documents it persists, which is what makes them shared between users and durable (locally, [comments](https://domternal.dev/v1/pro/comments/) also work with no server at all). Copy it into your project and adapt the marked spots. Infrastructure-specific policy is isolated in the token lookup in `src/create-server.mjs`, the one `authorizeDocument` callback in `index.mjs` shared by websocket and REST, and the persistence extension.

What it does:

- **Authentication and document authorization**: every connecting client must present a token (`HocuspocusProvider({ token })`). The example accepts tokens from the `COLLAB_TOKENS` env list, and a token that also appears in `COLLAB_READONLY_TOKENS` resolves to read-only on both websocket and REST. One async `authorizeDocument` callback in `index.mjs` gates document names on both surfaces, so they cannot drift. Its starter implementation permits every authenticated token to reach every document. Production refuses that permissive callback unless `COLLAB_ALLOW_TOKEN_WIDE_DOCUMENT_ACCESS=1` explicitly declares a deliberate single-tenant/global-token deployment. Multi-tenant deployments replace it with a tenant/session check before first start.
- **Read-only viewers**: tokens listed in `COLLAB_READONLY_TOKENS` connect with `connectionConfig.readOnly` set, so the document syncs down and the server drops every document write from that connection. Client-side `editable: false` is UX on top, and the enforcement is here. Awareness (presence, cursors) is deliberately not gated, since viewers should appear in presence, and the client presence UI caps and sanitizes whatever arrives on that channel.
- **Persistence**: documents are stored in SQLite via `@hocuspocus/extension-sqlite`. Swap it for `@hocuspocus/extension-database` with your own `fetch`/`store` to use Postgres or anything else.
- **Seeding**: brand-new documents get initial content in `onLoadDocument`, built directly as Y.Xml nodes (no ProseMirror schema needed server-side). Collaborative editors must not pass initial `content` client-side, because the server owns it. Brand-new is a stored flag in a `serverMeta` map, not an empty document: a user who clears the page on purpose would otherwise get the welcome content back on the next load. Documents whose first content arrives through the REST API are marked as owned the same way, so provisioning a document over REST never gets welcome content injected on top of it. The seed schedules its own store cycle, so it persists exactly once even when the first visitor only looks and leaves without editing. Pass `seed: null` to `createCollabServer` to disable seeding.
- **Comment-thread garbage collection**: comment deletes under collaboration are CRDT-safe tombstones, so `onStoreDocument` runs `collectThreadGarbage` and the server (the one safe authority) physically reclaims them. Without this, deleted threads accumulate in the document forever. It runs on every document and never throws: the threads map is peer-writable, and an exception inside this hook would strand deleted bodies in storage, stop webhook deliveries, pin the document in memory and hang shutdown. It also runs on read-triggered store cycles, deliberately: when a read is what finally crosses a doomed thread's reclaim margin, the reclamation is a real change, persists through its own follow-up store, and announces one `document.changed` about two seconds later; documents that are only ever read still get cleaned this way.
- **Webhooks** (optional, `WEBHOOK_URL`): HMAC-signed `document.changed` / `client.connected` / `client.disconnected` events via `src/webhook.mjs`, each body timestamped (`sentAt`) so receivers can refuse replays. The body is `{"event":"...","payload":{...},"sentAt":"<ISO 8601>"}`: `payload.documentName` is always present, the connection events add `payload.readOnly`, and version-history sibling documents (`mydoc-versions`) fire events like any other document. Production requires HTTPS and a secret of at least 32 bytes. `WEBHOOK_ALLOW_INSECURE_HTTP=1` is only for trusted private transport; unsigned delivery also needs `WEBHOOK_ALLOW_UNSIGNED=1` and outer authenticity. Payloads carry derived facts only, never auth context.
- **REST API** (optional, `REST_PORT`): read documents as ProseMirror JSON, export or apply raw Yjs updates, list versions and fetch any version's snapshot binary. Routes live in `src/rest.mjs`; bearer auth, read-only behavior and the `authorizeDocument` policy are the same as websocket. Binds to `127.0.0.1` by default, and `REST_HOST` exposes it deliberately. Reads are inert: a GET of a name nobody has opened yet returns an empty document without seeding it, persistence or webhook noise. Writes persist and announce normally. Malformed JSON, hostile paths or undecodable updates answer a bounded client error rather than exposing library internals.
- **Production guards**: with `NODE_ENV=production` the server refuses placeholder or sub-32-byte secrets, non-header-safe bearer tokens, a permissive document policy without the explicit single-tenant opt-in, HTTP webhooks without the private-transport opt-in, and unsigned webhooks without an outer-authenticity opt-in. Websocket messages default to an 8 MiB ceiling (`WS_MAX_PAYLOAD_BYTES`, at most 64 MiB). Binding either listener beyond loopback warns, deliberate or not. SIGINT/SIGTERM drains REST and flushes pending Hocuspocus stores before exit.

## Run

The reviewed bare-metal install builds native SQLite from source. Install
Python 3, `make` and a C/C++ compiler first, or use the Docker path to keep the
build toolchain off your host. On Debian or Ubuntu, install `python3` and
`build-essential`; on macOS, install the Xcode Command Line Tools. Generate an
independent token with `openssl rand -hex 32` and paste it into
`COLLAB_TOKENS`.

```bash
npm ci --ignore-scripts --strict-peer-deps
npm rebuild better-sqlite3 --build-from-source
cp .env.example .env   # then edit COLLAB_TOKENS
chmod 600 .env
# For a deliberate single-tenant evaluation only, also set:
# COLLAB_ALLOW_TOKEN_WIDE_DOCUMENT_ACCESS=1
npm start
```

Use Node 22.23.2. In this repository, `nvm use` at the root selects it; after
copying only this directory, select 22.23.2 with your own version manager. A
released revision installs `@domternal-pro/extension-comments` from
the public npm registry. This hardening checkout deliberately remains blocked
until both exact Pro packages are published and the real registry lock is
committed; see the maintainer release checklist rather than substituting a
workspace or private tarball. `npm start` forces `NODE_ENV=production` after
loading `.env`, so an inherited development setting cannot weaken the guards.
Placeholder or weak secrets and an undeclared permissive authorization model
fail before listeners start.

The committed npm lock is mandatory: it freezes the transitive deployment that
CI and Docker test. The two install commands reject ambiguous peer resolution,
suppress every dependency lifecycle script and then run only the reviewed
native SQLite build. For
mounted secrets, set `COLLAB_TOKENS_FILE`,
`COLLAB_READONLY_TOKENS_FILE` or `WEBHOOK_SECRET_FILE` instead of the matching
direct variable. Never set both forms. The root Compose file mounts ignored
host source files by default, keeping secret values out of the container
environment.

For database integrity, consistent backup and WAL-safe restore procedures, use
the root [`OPERATIONS.md`](../OPERATIONS.md) runbook. If you copy only this
service directory, copy and adapt that runbook too. A plain copy of a live
SQLite main file is not a safe backup.

For a token-free throwaway document server during evaluation there is also `npx --yes @hocuspocus/cli@4.6.0 --port 1234 --sqlite`; this server is the production-shaped one.

## Client side

```ts
const provider = new HocuspocusProvider({
  url: 'ws://127.0.0.1:1234',
  name: 'tenant-a/report-42',
  document: ydoc,
  token: 'replace-with-one-of-your-collab-tokens',
});
```

## Replace the token and document checks

`onAuthenticate` in `src/create-server.mjs` is the token/role check, while the
single `authorizeDocument` callback in `index.mjs` gates document names for both
websocket and REST. Replace both with calls to the same session/JWT policy; do
not put a second, drifting document policy inside `src/rest.mjs`.

For example, the centralized callback can ask an internal authorization route.
It receives the raw token, document name and requested read/write mode, and only
literal `true` authorizes:

```js
async function authorizeDocument({ token, documentName, mode }) {
  const response = await fetch('https://your.internal.app/api/collab/authorize', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ documentName, mode }),
  });
  return response.ok;
}
```

For locally verified JWTs, verify signature and expiry and compare a tenant claim
to a tenant-scoped name such as `tenant-a/report-42`. Once `onAuthenticate`
uses the real session lookup, `COLLAB_TOKENS` and `COLLAB_READONLY_TOKENS` have
no job left. Delete the permissive production opt-in rather than leaving it set.

## Scaling notes

- One Hocuspocus process handles many documents, and a document unloads when its last client disconnects.
- Put connection, request-rate and aggregate body limits at the authenticated
  reverse proxy. The websocket frame and REST body ceilings protect one request
  or frame; they do not cap memory consumed by many authorized connections.
- For horizontal scaling, add `@hocuspocus/extension-redis` and put the processes behind a sticky-session load balancer. Point it at **Valkey** (or another open Redis-protocol server): Redis 8+ itself is tri-licensed and one of its licenses is AGPL, so name the server you deploy deliberately.
- Do not build on `@y/hub` (the yjs-org production server) without reading its license: it is AGPL/dual-licensed, unlike the MIT Hocuspocus stack used here.

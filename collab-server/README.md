# Reference collaboration server

A minimal, production-shaped [Hocuspocus](https://hocuspocus.dev) v4 server for Domternal Pro. One server backs three features: real-time collaboration syncs through it, [version history](https://domternal.dev/v1/pro/version-history/) keeps its snapshots on it in sibling documents, and comment threads live inside the documents it persists, which is what makes them shared between users and durable (locally, [comments](https://domternal.dev/v1/pro/comments/) also work with no server at all). Copy it into your project and adapt the marked spots. Infrastructure-specific policy is isolated in the token lookup in `src/create-server.mjs`, the one `authorizeDocument` callback in `index.mjs` shared by websocket and REST, and the persistence extension. This MIT server has no Domternal Pro package dependency and does not need, read or validate a Domternal Pro license key.

What it does:

- **Authentication and document authorization**: every connecting client must present a token (`HocuspocusProvider({ token })`). The example accepts tokens from the `COLLAB_TOKENS` env list, and a token that also appears in `COLLAB_READONLY_TOKENS` resolves to read-only on both websocket and REST. One async `authorizeDocument` callback in `index.mjs` gates document names on both surfaces, so they cannot drift. Its starter implementation permits every authenticated token to reach every document, and the line `authorizeDocument.isPermissiveStarter = true;` under it is what marks it as the shipped starter. While that marker is present the server refuses to start outside `NODE_ENV=development` unless `COLLAB_ALLOW_TOKEN_WIDE_DOCUMENT_ACCESS=1` explicitly declares a deliberate single-tenant/global-token deployment, and every boot warns. Delete the marker with the starter body and both stop: the guards test your policy's absence, not the environment variable alone. Multi-tenant deployments replace it with a tenant/session check before first start.
- **Read-only viewers**: tokens listed in `COLLAB_READONLY_TOKENS` connect with `connectionConfig.readOnly` set, so the document syncs down and the server drops every document write from that connection. Client-side `editable: false` is UX on top, and the enforcement is here. A viewer also cannot bring a document into existence: opening a name nobody has used yet syncs an empty, unseeded document and persists nothing, and welcome content appears only when a writing connection loads that name fresh. Awareness (presence, cursors) is deliberately not gated server-side, since viewers should appear in presence: a read-only connection can broadcast any awareness state it likes to its peers, and the only thing capping and sanitizing that channel is client code you can replace.
- **Persistence**: documents are stored in SQLite via `@hocuspocus/extension-sqlite`. The server puts that connection into WAL mode with a 5-second busy timeout at startup, because the online backup in [`OPERATIONS.md`](../OPERATIONS.md) restarts on every write to the source under the default rollback journal and can never converge on a busy server. A live database therefore has `-wal` and `-shm` sidecars beside it, and a filesystem that refuses WAL (many network mounts do) is reported at boot rather than silently accepted. Swap the extension for `@hocuspocus/extension-database` with your own `fetch`/`store` to use Postgres or anything else.
- **Seeding**: brand-new documents get initial content in `onLoadDocument`, built directly as Y.Xml nodes (no ProseMirror schema needed server-side). Collaborative editors must not pass initial `content` client-side, because the server owns it. Brand-new is a stored flag in a `serverMeta` map, not an empty document: a user who clears the page on purpose would otherwise get the welcome content back on the next load. Documents whose first content arrives through the REST API are marked as owned the same way, so provisioning a document over REST never gets welcome content injected on top of it. The seed schedules its own store cycle, so it persists exactly once even when the first visitor only looks and leaves without editing. Pass `seed: null` to `createCollabServer` to disable seeding.
- **Comment-thread garbage collection**: comment deletes under collaboration are CRDT-safe tombstones, so `onStoreDocument` runs `collectThreadGarbage` and the server (the one safe authority) physically reclaims them. Without this, deleted threads accumulate in the document forever. It runs on every document and never throws: the threads map is peer-writable, and an exception inside this hook would strand deleted bodies in storage, stop webhook deliveries, pin the document in memory and hang shutdown. It also runs on read-triggered store cycles, deliberately: when a read is what finally crosses a doomed thread's reclaim margin, the reclamation is a real change, persists through its own follow-up store, and announces one `document.changed` about two seconds later; documents that are only ever read still get cleaned this way.
- **Webhooks** (optional, `WEBHOOK_URL`): HMAC-signed `document.changed` / `client.connected` / `client.disconnected` events via `src/webhook.mjs`, each body timestamped (`sentAt`) so receivers can refuse replays. The body is `{"event":"...","payload":{...},"sentAt":"<ISO 8601>"}`: `payload.documentName` is always present, the connection events add `payload.readOnly`, and version-history sibling documents (`mydoc-versions`) fire events like any other document. Production requires HTTPS and a secret of at least 32 bytes. `WEBHOOK_ALLOW_INSECURE_HTTP=1` is only for trusted private transport; unsigned delivery also needs `WEBHOOK_ALLOW_UNSIGNED=1` and outer authenticity. Payloads carry derived facts only, never auth context.
- **REST API** (optional, `REST_PORT`): read documents as ProseMirror JSON, export or apply raw Yjs updates, list versions and fetch any version's snapshot binary. Routes live in `src/rest.mjs`; bearer auth, read-only behavior and the `authorizeDocument` policy are the same as websocket, and the two version routes authorize the sibling document they open rather than its parent (see [Document names and the version sibling](#document-names-and-the-version-sibling)). Binds to `127.0.0.1` by default, and `REST_HOST` exposes it deliberately. Reads are inert: a GET of a name nobody has opened yet returns an empty document without seeding it, persistence or webhook noise. Writes persist and announce normally. Malformed JSON, hostile paths or undecodable updates answer a bounded client error rather than exposing library internals.
- **Production guards**: unless `NODE_ENV` is exactly `development`, the server refuses placeholder or sub-32-byte secrets, the shipped starter document policy without the explicit single-tenant opt-in, HTTP webhooks without the private-transport opt-in, and unsigned webhooks without an outer-authenticity opt-in. An unset or unknown `NODE_ENV` counts as production, because a systemd unit, pm2 or a bare Kubernetes Deployment starts the process without one; only `NODE_ENV=development` downgrades those refusals to warnings. Three refusals are not environment-dependent at all and fire everywhere: an empty `COLLAB_TOKENS`, a bearer token that is not header-safe, and a data directory the process cannot write. Websocket messages default to an 8 MiB ceiling (`WS_MAX_PAYLOAD_BYTES`, at most 64 MiB). Binding either listener beyond loopback warns, deliberate or not. SIGINT/SIGTERM drains REST and flushes pending Hocuspocus stores before exit.

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
# For a deliberate single-tenant/global-token deployment only, also set:
# COLLAB_ALLOW_TOKEN_WIDE_DOCUMENT_ACCESS=1
npm start
```

Use Node 22.23.2. In this repository, `nvm use` at the root selects it; after
copying only this directory, select 22.23.2 with your own version manager. The
comment-thread collector is local MIT source in `src/thread-gc.mjs`; the server
has no runtime or development dependency on a Domternal Pro package. `npm
start` forces `NODE_ENV=production` after
loading `.env`, so an inherited development setting cannot weaken the guards.
Placeholder or weak secrets, and the shipped starter authorization policy while
its marker is still in `index.mjs`, fail before listeners start.

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

## Document names and the version sibling

A document name is a storage key on both surfaces, so one contract in
`src/document-name.mjs` validates it before authorization, persistence or a log
line ever sees it. A name must be a non-empty string of at most 1024 UTF-8
bytes, must contain no ASCII control characters, and must already be in Unicode
NFC form. The NFC rule is what stops two spellings of the same name from
becoming two storage keys and two authorization subjects; normalize on the
client, because the server refuses rather than rewrites. Nothing else is
normalized either: only an all-whitespace name is rejected, so `" report"` and
`"report"` are two documents. A rejected name fails the websocket connection
(the provider fires `onAuthenticationFailed`) and answers REST with 400, and the
message names the rule it broke, never the name.

Names ending in `-versions` or `/versions` are reserved for the snapshot
documents that [version history](https://domternal.dev/v1/pro/version-history/)
keeps beside a document, and are never seeded with welcome content.

Version history lives in a separate document, and it is authorized as one.
`GET /documents/{name}/versions` and `GET /documents/{name}/versions/{id}/update`
never open `{name}`: they open `{name}-versions` and call `authorizeDocument`
with that derived name, which is the name a websocket client opening the same
sibling is authorized under too. The mode differs by surface rather than by
document: these two routes always ask with `read`, while a websocket connection
asks with the mode that connection carries. A strict policy must therefore allow
`<name>-versions` for everyone permitted to read that document's history;
allowing only the parent name answers 403 naming the sibling. Only the
`-versions` form is derived here, so a deployment whose version store uses the
`/versions` form is not reachable through these two routes at all.

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
to a tenant-scoped name such as `tenant-a/report-42`.

Going to production takes three steps, and the last one is the part people miss:

1. **Both token lookups, not one.** `onAuthenticate` in `src/create-server.mjs`
   decides websocket tokens, and `canRead`/`canWrite` in `src/rest.mjs` decide
   REST ones. They read the same two Sets today, so a session lookup that
   replaces only `onAuthenticate` leaves the REST API trusting the static lists.
2. **The document policy and its marker.** Replace `authorizeDocument` in
   `index.mjs` and delete the `authorizeDocument.isPermissiveStarter = true;`
   line together with the starter body. Both guards hang off that marker, so
   removing it is what stops the production refusal and the boot warning.
   `COLLAB_ALLOW_TOKEN_WIDE_DOCUMENT_ACCESS` is then read nowhere, and leaving
   it set only misdescribes the deployment: remove it.
3. **`COLLAB_TOKENS` stays.** The entrypoint exits with `Set COLLAB_TOKENS to at
   least one accepted token (comma separated).` in every environment, before any
   of your code runs, and the placeholder, header-safe and 32-byte guards still
   inspect whatever both lists hold. Keep one real random value there even after
   nothing consults it, or remove that startup guard deliberately in your fork.
   `COLLAB_READONLY_TOKENS` may stay empty.

## Scaling notes

- One Hocuspocus process handles many documents, and a document unloads when its last client disconnects.
- Put connection, request-rate and aggregate body limits at the authenticated
  reverse proxy. The websocket frame and REST body ceilings protect one request
  or frame; they do not cap memory consumed by many authorized connections.
- For horizontal scaling, add `@hocuspocus/extension-redis` and put the processes behind a sticky-session load balancer. Point it at **Valkey** (or another open Redis-protocol server): Redis 8+ itself is tri-licensed and one of its licenses is AGPL, so name the server you deploy deliberately.
- Do not build on `@y/hub` (the yjs-org production server) without reading its license: it is AGPL/dual-licensed, unlike the MIT-licensed direct Hocuspocus packages and permissively licensed dependency stack used here.

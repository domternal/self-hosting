# Reference collaboration server

A minimal, production-shaped [Hocuspocus](https://hocuspocus.dev) v4 server for Domternal Pro collaboration. Copy it into your project and adapt the marked spots; everything specific to your infrastructure is isolated in the auth checks (the token lookup in `src/create-server.mjs`, and `authorizeDocument` in `src/rest.mjs` if you enable the REST API) and the persistence extension.

What it does:

- **Authentication**: every connecting client must present a token (`HocuspocusProvider({ token })`). The example accepts tokens from the `COLLAB_TOKENS` env list; replace the lookup in `src/create-server.mjs` with your real check (verify a JWT, hit your session store) and authorize the requested document name there. With tenant-scoped names such as `tenant-a/report-42` that is a prefix comparison.
- **Read-only viewers**: tokens listed in `COLLAB_READONLY_TOKENS` connect with `connectionConfig.readOnly` set, so the document syncs down and the server drops every document write from that connection. Client-side `editable: false` is UX on top; the enforcement is here. Awareness (presence, cursors) is deliberately not gated, viewers should appear in presence; the client presence UI caps and sanitizes whatever arrives on that channel.
- **Persistence**: documents are stored in SQLite via `@hocuspocus/extension-sqlite`. Swap it for `@hocuspocus/extension-database` with your own `fetch`/`store` to use Postgres or anything else.
- **Seeding**: brand-new documents get initial content in `onLoadDocument`, built directly as Y.Xml nodes (no ProseMirror schema needed server-side). Collaborative editors must not pass initial `content` client-side; the server owns it.
- **Comment-thread garbage collection**: comment deletes under collaboration are CRDT-safe tombstones; `onStoreDocument` runs `collectThreadGarbage` so the server (the one safe authority) physically reclaims them. Without this, deleted threads accumulate in the document forever.
- **Webhooks** (optional, `WEBHOOK_URL`): HMAC-signed `document.changed` / `client.connected` / `client.disconnected` events via `src/webhook.mjs`, each body timestamped (`sentAt`) so receivers can refuse replays. Set `WEBHOOK_SECRET` or the server warns at startup that deliveries go out unsigned. Payloads carry derived facts only, never auth context. Deliberately not `@hocuspocus/extension-webhook`, whose transformer dependency ships the whole @tiptap editor server-side.
- **REST API** (optional, `REST_PORT`): read documents as ProseMirror JSON, export or apply raw Yjs updates, list versions and fetch any version's snapshot binary. Routes in `src/rest.mjs`; auth uses the same tokens as bearer headers, and `authorizeDocument` in there is the per-document hook to replace for multi-tenant use. Binds to `127.0.0.1` by default; set `REST_HOST` to expose it deliberately. REST reads never seed: a GET of a name nobody has opened yet returns an empty document, and only the websocket path plants welcome content. Note that applying a full fresh-document state MERGES it next to existing content (CRDT semantics); see the note in `src/rest.mjs`.
- **Production guards**: with `NODE_ENV=production` the server refuses to start with placeholder tokens (`change-me` and friends), and refuses to expose the REST API beyond loopback with them; without `NODE_ENV=production` the same conditions warn instead. The permissive `authorizeDocument` placeholder announces itself at startup until you replace it.

## Run

```bash
npm install
cp .env.example .env   # then edit COLLAB_TOKENS
node --env-file=.env index.mjs
```

Requires Node >= 22. The `@domternal-pro/extension-comments` dependency installs from the public npm registry like every Domternal Pro package.

For a token-free throwaway document server during evaluation there is also `npx @hocuspocus/cli@4 --port 1234 --sqlite`; this server is the production-shaped one.

## Client side

```ts
const provider = new HocuspocusProvider({
  url: 'ws://127.0.0.1:1234',
  name: 'tenant-a/report-42',
  document: ydoc,
  token: 'change-me',
});
```

## Scaling notes

- One Hocuspocus process handles many documents; documents unload when the last client disconnects.
- For horizontal scaling, add `@hocuspocus/extension-redis` and put the processes behind a sticky-session load balancer. Point it at **Valkey** (or another open Redis-protocol server): Redis 8+ itself is tri-licensed and one of its licenses is AGPL, so name the server you deploy deliberately.
- Do not build on `@y/hub` (the yjs-org production server) without reading its license: it is AGPL/dual-licensed, unlike the MIT Hocuspocus stack used here.

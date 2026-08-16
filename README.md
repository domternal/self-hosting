# Domternal self-hosting

Reference backends for [Domternal Pro](https://domternal.dev/pro/): the parts that run on **your** infrastructure. Domternal hosts nothing, so nothing ever passes through our servers: documents and comments live where you deploy them, and AI prompts go from your backend straight to the provider you choose, under your own contract (or to a local model, and then nothing leaves at all). These are the two services that make that work, ready to copy and adapt.

| Directory | What it is | You need it for |
| --- | --- | --- |
| [`collab-server/`](./collab-server) | A production-shaped [Hocuspocus](https://hocuspocus.dev) v4 server: token auth, server-enforced read-only viewers, SQLite persistence, comment-thread garbage collection, signed webhooks, and a REST API | Real-time collaboration, version history, shared comments |
| [`ai-proxy/`](./ai-proxy) | A zero-dependency streaming proxy that keeps your AI provider key server-side | The AI assistant |

Everything else in Domternal Pro (columns, export, the editor itself) is client-only and needs no backend at all. Comments sit in between: they work locally with no server, and the collaboration server is what makes threads shared between users and durable.

Each directory is self-contained and carries its own README with the full walkthrough, so copying one directory into your project takes its documentation along. This page orients you and gets both services running.

## Try collaboration in 30 seconds

For a throwaway document server during evaluation, skip this repository entirely:

```bash
npx @hocuspocus/cli@4 --port 1234 --sqlite
```

That is a generic relay: fine for trying the editor, not for production. It does not authenticate anyone, and it never reclaims deleted comment threads, so tombstones accumulate in the document forever. The server in this repository does both.

## Quick start

Use this repository as a GitHub template (or clone it), then set up each service.

The collaboration server, with the full walkthrough in [`collab-server/README.md`](./collab-server/README.md):

```bash
cd collab-server
npm install
cp .env.example .env   # then edit the tokens
node --env-file=.env index.mjs
```

The AI proxy, with the full walkthrough in [`ai-proxy/README.md`](./ai-proxy/README.md):

```bash
cd ai-proxy
cp .env.example .env   # then set UPSTREAM_URL, PROVIDER, PROVIDER_API_KEY and AI_TOKENS
node --env-file=.env index.mjs
```

Or run both with Docker:

```bash
COLLAB_TOKENS=<secret> UPSTREAM_URL=https://api.openai.com/v1/chat/completions \
PROVIDER_API_KEY=<key> AI_TOKENS=<secret> docker compose up --build
```

Requires Node >= 22 (or any OCI runtime for the compose path).

## Before production

Each service isolates what you must replace in clearly marked spots:

- **`collab-server`**: the token check in `src/create-server.mjs` (swap the static list for your JWT or session lookup, and authorize the document name), and `authorizeDocument` in `src/rest.mjs` for multi-tenant deployments. Persistence is not on this list: SQLite is production-fine for a single process, and swapping in `@hocuspocus/extension-database` is what you do when you outgrow that.
- **`ai-proxy`**: the caller check in `src/create-proxy.mjs` (swap the static token list for your session check).

Replace the token checks first. A static token list reaches the browser, so any user can read one out and use it outside your app, and withdrawing it cuts off everyone at once. Both services refuse to start with placeholder tokens when `NODE_ENV=production`, so a forgotten `change-me` fails loudly instead of shipping.

## Support and license

This repository is MIT licensed and provided as is: it is a starting point you own and adapt, not a managed product, and it is not covered by Domternal Pro support plans, which cover the editor packages. The `@domternal-pro` packages it installs are not MIT: they remain under the [Domternal Pro commercial license](https://domternal.dev/license/), and running them in production needs a license key. The full guide lives in the [self-hosting documentation](https://domternal.dev/v1/pro/self-hosting/), and problems and suggestions are welcome on the [issue tracker](https://github.com/domternal/domternal/issues).

# Domternal self-hosting

Reference backends for [Domternal Pro](https://domternal.dev/pro/): the parts that run on **your** infrastructure. Domternal does not provide a hosted instance of these reference services for your Application. In a deployment of this source, documents and comments live where you deploy them, and AI prompts go from your backend straight to the provider you choose, under your own contract (or to a local model, and then nothing leaves at all). Traffic reaches only the endpoints your host explicitly configures. The separate Domternal-operated website demo is governed by the published [Privacy Policy](https://domternal.dev/privacy/). These are the two services that make customer-controlled hosting work, ready to copy and adapt.

| Directory | What it is | You need it for |
| --- | --- | --- |
| [`collab-server/`](./collab-server) | A production-shaped [Hocuspocus](https://hocuspocus.dev) v4 server: token auth, server-enforced read-only viewers, SQLite persistence, comment-thread garbage collection, signed webhooks, and a REST API | Real-time collaboration, version history, shared comments |
| [`ai-proxy/`](./ai-proxy) | A zero-dependency streaming proxy that keeps your AI provider key server-side | The AI assistant |

Everything else in Domternal Pro (columns, export, the editor itself) is client-only and needs no backend at all. Comments sit in between: they work locally with no server, and the collaboration server is what makes threads shared between users and durable.

Each service directory carries its own setup README, so copying one into your project takes the service-specific walkthrough along. Repository-wide backup, restore and release procedures remain in `OPERATIONS.md` and `docs/`; copy or replace those procedures when your deployment needs them.

## Try collaboration in 30 seconds

For a throwaway document server during evaluation, skip this repository entirely:

```bash
npx --yes @hocuspocus/cli@4.6.0 --port 1234 --sqlite
```

That is a generic relay: fine for trying the editor, not for production. It does not authenticate anyone, and it never reclaims deleted comment threads, so tombstones accumulate in the document forever. The server in this repository does both.

## Quick start

Use this repository as a GitHub template (or clone it), then set up each service.

The collaboration server, with the full walkthrough in [`collab-server/README.md`](./collab-server/README.md):

```bash
cd collab-server
npm ci --ignore-scripts --strict-peer-deps
npm rebuild better-sqlite3 --build-from-source
cp .env.example .env   # then edit the tokens
chmod 600 .env
# Use real random tokens. For an intentional single-tenant deployment, also
# set COLLAB_ALLOW_TOKEN_WIDE_DOCUMENT_ACCESS=1.
npm start
```

`npm ci` is deliberate: `collab-server/package-lock.json` is a deployment
artifact, not a disposable local file. `--ignore-scripts` prevents dependencies
from executing lifecycle code during installation, while `--strict-peer-deps`
turns an ambiguous peer resolution into a failure; the next command runs only
the reviewed native build required by `better-sqlite3`. Together they install
the same transitive code CI tested and Docker deploys.

The AI proxy, with the full walkthrough in [`ai-proxy/README.md`](./ai-proxy/README.md):

```bash
cd ai-proxy
cp .env.example .env   # then set UPSTREAM_URL, PROVIDER, PROVIDER_API_KEY and AI_TOKENS
chmod 600 .env
npm start
```

Or run both with Docker. Use Docker Engine with a current Docker Compose v2
plugin, invoked as `docker compose`; legacy `docker-compose` and Podman Compose
are not validated substitutes. Compose reads non-secret settings and host
secret-file paths from a `.env` next to `docker-compose.yml` (not from the
per-service `.env` files):

```bash
cp -n .env.example .env
chmod 600 .env
install -d -m 700 secrets
(
  set -euC
  for path in \
    secrets/collab_tokens \
    secrets/collab_readonly_tokens \
    secrets/webhook_secret \
    secrets/provider_api_key \
    secrets/ai_tokens
  do
    if [ -e "$path" ]; then
      echo "Refusing to overwrite $path" >&2
      exit 1
    fi
  done
  umask 022
  openssl rand -hex 32 > secrets/collab_tokens
  openssl rand -hex 32 > secrets/ai_tokens
  : > secrets/collab_readonly_tokens
  : > secrets/webhook_secret
  : > secrets/provider_api_key
  chmod 644 \
    secrets/collab_tokens \
    secrets/collab_readonly_tokens \
    secrets/webhook_secret \
    secrets/provider_api_key \
    secrets/ai_tokens
)
# Put the provider-issued API key in secrets/provider_api_key. Add independent
# viewer tokens or a webhook signing key only when those features are enabled.
# For an intentional single-tenant starter deployment, set
# COLLAB_ALLOW_TOKEN_WIDE_DOCUMENT_ACCESS='1'. Multi-tenant users must instead
# replace authorizeDocument in collab-server/index.mjs before starting.
docker compose config --quiet
```

`cp -n` keeps an existing `.env`, and the secret setup refuses to overwrite any
existing source file. Edit or rotate existing settings deliberately instead of
rerunning initialization over them. Both `.env` and `secrets/` are ignored by
Git and must never be committed.

Why those modes, what each service is allowed to read, and how to point the five
`*_SOURCE_FILE` variables at a host secret manager are covered once, in
[`OPERATIONS.md`](./OPERATIONS.md#secrets).

Then start only the services you want:

```bash
docker compose up --build collab-server        # collaboration only
docker compose up --build                      # collaboration and the AI proxy
```

Starting both needs a real provider key in `secrets/provider_api_key`, because
the AI proxy refuses to start without one outside development and
`restart: unless-stopped` then retries it for as long as the deployment lives.
The bootstrap above creates that file empty on purpose, so a collaboration-only
deployment names its one service instead.

The shipped Compose posture is intentionally conservative:

- all published ports bind to host loopback; put an authenticated TLS reverse
  proxy in front ([worked nginx configuration](./OPERATIONS.md#reverse-proxy-and-tls))
  or deliberately change the host IP when remote clients need it
- both root filesystems are read-only, `/tmp` is a small `noexec` tmpfs, all
  Linux capabilities are dropped and privilege escalation is disabled
- collaboration and AI use separate bridge networks
- only the named `/data` volume is writable and durable
- logs rotate locally instead of consuming the host disk without a bound

`docker compose up` preserves the collaboration volume. Operational procedures
for consistent backup, integrity checks, tested restore, upgrades, rollback and
intentional data deletion are in [`OPERATIONS.md`](./OPERATIONS.md).

Bare-metal runs use the validated Node 22 line (`nvm use` selects 22.23.2);
the Docker path carries that exact runtime itself.

### When you customize the template

Docker contexts are default-deny. If you add a runtime source file, explicitly
allow its exact path in that service's `.dockerignore`; the policy test fails
until the file is classified, so it cannot be silently absent from an image or
silently leak into one. When the collaboration service gains a dependency,
classify and pin it in `collab-server/scripts/runtime-dependencies.mjs`, update
`package.json`, regenerate the real registry lock, and review the lock diff.
When the zero-dependency AI proxy gains one, add a frozen install/build stage
rather than copying a host `node_modules`. Security checks are guardrails for
your fork, so update them deliberately alongside an intentional architecture
change instead of deleting them to make a red build green.

### Upgrading a Docker deployment that predates the non-root images

The containers now run as the unprivileged `node` user. A `collab-data` volume created by an older root-based image keeps its root ownership, and the collaboration server then refuses to start with a message naming this section (better a loud refusal than the silent alternative: a read-only database that looks healthy while every save fails and edits vanish on the next restart). Fix it once:

```bash
docker compose run --rm --user 0 --cap-add CHOWN --no-deps collab-server chown -R node:node /data
```

Fresh deployments never need this: a volume created by the current image is owned correctly from the start.

## Before production

Each service isolates what you must replace in clearly marked spots:

- **`collab-server`**: replace the centralized `authorizeDocument` callback in
  `index.mjs` with tenant-aware document authorization, and replace the static
  token lookups in `src/create-server.mjs` and `src/rest.mjs` with your
  JWT/session lookup. Production refuses the shipped starter callback while its
  `isPermissiveStarter` marker is in place, unless
  `COLLAB_ALLOW_TOKEN_WIDE_DOCUMENT_ACCESS=1` explicitly declares an
  intentional single-tenant/global-token model; deleting the marker with the
  starter body is what retires both that refusal and the opt-in. Persistence
  still needs an application-specific review: SQLite can suit one process when
  its workload, concurrency, durability, backup and recovery requirements have
  been validated; use a shared database when you scale horizontally or exceed
  those limits.
- **`ai-proxy`**: the caller check in `src/create-proxy.mjs` (swap the static token list for your session check).

Replace the token checks first. A static token list reaches the browser, so any user can read one out and use it outside your app, and withdrawing it cuts off everyone at once. Both services refuse to start with placeholder tokens unless `NODE_ENV` is exactly `development`, so a forgotten `change-me` fails loudly instead of shipping, including on a host that sets no `NODE_ENV` at all.

Also terminate TLS before these services
([worked nginx configuration](./OPERATIONS.md#reverse-proxy-and-tls)), restrict
that gateway/firewall to the clients that need each port, and keep
provider/document backups under your own retention policy. Loopback defaults prevent accidental public exposure; they do
not replace authentication, tenant authorization or TLS when you expose them.
At the same edge, enforce per-user and per-source connection, request-rate and
aggregate body limits. The application limits each request or frame, but many
individually valid concurrent requests can still consume memory or provider
budget.

## Support, contributions and license

This repository and both server implementations are MIT licensed and provided
as is: they are a starting point you may copy and adapt under that license, not
a managed product. Neither server installs a Domternal Pro package, and neither
server needs, reads, stores or validates a Domternal Pro license key. Commercial
activation belongs only to the separate Domternal Pro editor packages in the
application that imports them, including guarded headless use.
[Installation and licensing](https://domternal.dev/v1/pro/licensing/) covers
browser and headless initialization and how offline validation works. See [SUPPORT.md](./SUPPORT.md)
for help and defect reporting, [CONTRIBUTING.md](./CONTRIBUTING.md) before
proposing a change, and [SECURITY.md](./SECURITY.md) for private vulnerability
reporting.

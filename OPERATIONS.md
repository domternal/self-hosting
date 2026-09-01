# Operations runbook

This runbook covers the stateful collaboration service. The AI proxy stores no
documents, prompts or provider replies on disk; your provider and reverse proxy
can have separate retention policies outside this repository.

Run commands from the repository root. Keep `.env` mode `600`, the ignored
`secrets/` directory mode `700`, and its source files mode `644`. Use an
operator account allowed to run Docker, and take a backup before every upgrade
or restore.
Membership in the Docker group is effectively root access to the host.
These procedures require Docker Engine and a current Docker Compose v2 plugin,
invoked as `docker compose`. Legacy `docker-compose` and Podman Compose are not
validated substitutes. Confirm `docker compose version` and run
`docker compose config --quiet` after every configuration change.

## Secrets

The one-time bootstrap that creates the default host files and generates
independent high-entropy caller tokens is in the
[README quick start](./README.md#quick-start), where a first-time reader needs
it. It refuses to overwrite an existing source file, so edit or rotate an
existing deployment deliberately instead of rerunning it. The rest of this
section is why those commands look the way they do, and it is the reference for
everything after the first day.

Put the provider-issued key in `secrets/provider_api_key`. Leave the viewer and
webhook files empty until those features are enabled, then add independent
values. Hex avoids commas, whitespace and header metacharacters. Never reuse an
AI caller token as a provider key or collaboration token.

The host directory mode is the confidentiality boundary: mode `700` prevents
other host users from traversing it. Files use mode `644` because Compose
bind-mounts them read-only into containers and does not implement uid/gid
remapping for file-backed secrets; mode `600` can make them unreadable when the
host operator uid differs from container uid 1000. Each service receives only
its declared files, and their contents never enter container environment
variables or image layers.

The five host paths default under `./secrets`. Override them in `.env` when a
host secret manager provides files elsewhere:

- `COLLAB_TOKENS_SOURCE_FILE`
- `COLLAB_READONLY_TOKENS_SOURCE_FILE`
- `WEBHOOK_SECRET_SOURCE_FILE`
- `PROVIDER_API_KEY_SOURCE_FILE`
- `AI_TOKENS_SOURCE_FILE`

The applications read the corresponding fixed `*_FILE` paths under
`/run/secrets`. A custom orchestrator may mount Vault, SOPS, systemd,
Kubernetes or Docker-managed files there. At the application level, set either
`NAME` or `NAME_FILE`, never both.

Secret files must contain valid UTF-8, stay below 64 KiB, and may end in one or
more line endings because readers trim them. Production bearer and webhook
secrets must contain at least 32 UTF-8 bytes; bearer tokens must also be
header-safe and no larger than 4096 bytes. `openssl rand -hex 32` satisfies
every token rule. Errors never print a secret value.

For an overlap rotation that avoids abruptly revoking current callers, put the
old and new tokens in the same comma-separated source file, recreate that
service, move clients to the new token, remove the old token, then recreate the
service again. Each `--force-recreate` restarts the shipped singleton and can
briefly interrupt requests or make clients reconnect. True zero-downtime
rotation requires multiple service instances or a gateway that can drain one
instance while another remains available. Recreating remounts the current host
file even when a secret manager replaces it atomically:

```bash
docker compose up --detach --force-recreate collab-server
docker compose up --detach --force-recreate ai-proxy
```

Hosted-provider upstreams and webhooks use HTTPS in production by default.
`UPSTREAM_ALLOW_INSECURE_HTTP=1` and `WEBHOOK_ALLOW_INSECURE_HTTP=1` exist only
for explicitly trusted private transports; they do not add encryption. An
unsigned webhook separately requires `WEBHOOK_ALLOW_UNSIGNED=1` and an outer
system that provides authenticity.

## Edge exposure and aggregate limits

Keep the shipped loopback bindings unless an authenticated TLS reverse proxy
or private gateway is ready in front of them
([worked configuration](#reverse-proxy-and-tls)). At that edge, cap simultaneous
connections, requests per authenticated user and source, and aggregate request
body throughput for both services. Keep gateway body limits at or below the
application limits unless the application limits are changed and retested.

The application bounds each websocket frame, REST body and AI request, while
Compose limits process count and caps each container's memory. Those controls
still do not cap the sockets or the provider spend created by many
individually valid requests at once, and a container that reaches its memory
ceiling is killed and restarted rather than slowed down. Configure
idle and upstream timeouts at the gateway too, but keep them long enough for
expected collaboration sessions and streaming AI responses.

## Reverse proxy and TLS

Neither service terminates TLS, and both bind host loopback, so the proxy runs
on the same host and is the only thing users reach. The nginx configuration
below is a starting point, written around the three failures that arrive quietly
rather than loudly: a websocket that never finishes its handshake, a websocket
that drops on a fixed interval, and an AI reply that arrives all at once,
seconds late.

```nginx
# Hop-by-hop upgrade handling. 'close' for ordinary requests, because a
# hardcoded "Connection: upgrade" breaks keepalive on everything else.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name collab.example.com;

    ssl_certificate     /etc/letsencrypt/live/collab.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/collab.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:1234;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host       $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

server {
    listen 443 ssl;
    server_name ai.example.com;

    ssl_certificate     /etc/letsencrypt/live/ai.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ai.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:1250;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        gzip off;
        proxy_read_timeout 300s;
        client_max_body_size 1m;
    }
}
```

Which directive answers which failure:

- `proxy_http_version 1.1` with the two `Upgrade`/`Connection` headers and the
  `map` block: without them nginx speaks HTTP/1.0 upstream and drops the
  hop-by-hop upgrade headers, so the handshake never completes. The symptom is a
  provider that reconnects forever while the collaboration server logs nothing,
  because no connection ever reached it.
- `proxy_read_timeout` (and `proxy_send_timeout` for symmetry): nginx closes a
  connection when the upstream has produced nothing for this long, and the
  default is 60 seconds. A document nobody is typing in produces nothing between
  keepalives, so a short timeout shows up as sessions dropping and resyncing on
  a fixed interval. Keep it well above the keepalive interval of both ends.
- `proxy_buffering off`, plus `proxy_cache off` and `gzip off` in that same
  location: with buffering on, nginx collects the AI proxy's `text/event-stream`
  into its proxy buffers and forwards it when they fill, so tokens that were
  streamed word by word arrive as one block after a long pause. Compression
  re-introduces exactly that delay by buffering to compress, which is why `gzip`
  is off here rather than only globally.
- `client_max_body_size 1m`: matches the proxy's own 1 MB request cap, so an
  oversized prompt is refused at the edge with a 413 instead of having its
  socket torn down. Keep gateway limits at or below the application limits.

Authentication stays with the services, but they do not all read the token from
the same place. The AI proxy, and the REST API if you publish it, read
`Authorization: Bearer`, so nginx must forward that header untouched: do not
set `proxy_set_header Authorization ""` in those blocks. The collaboration
websocket carries its token in the connection the client opens rather than in a
proxied request header, so it needs the upgrade headers below instead. Add
the per-user and per-source `limit_conn` and `limit_req` zones this runbook asks
for in [Edge exposure and aggregate limits](#edge-exposure-and-aggregate-limits)
to the same locations.

Serving the AI proxy from the application's own origin (a `location /ai/` in the
app's server block, with `proxy_pass http://127.0.0.1:1250/;` and the same four
streaming directives) needs no CORS at all. A separate hostname, as above, needs
the exact app origins in `ALLOWED_ORIGINS`.

The REST API on port 1235 is deliberately absent from these blocks. It is an
administrative surface: publish it only where you need it, to the clients that
need it, and give it `client_max_body_size 8m` to match its own body cap.

## When it does not start

The refusals below that name production are armed unless `NODE_ENV` is exactly
`development`. An unset, empty, `test` or `staging` value counts as production,
deliberately: a systemd unit or a bare Kubernetes Deployment sets nothing, and
those are exactly the hosts that need the refusal. `npm start` and both Docker
images force production, so `NODE_ENV=development` is something you ask for
explicitly. The refusals that do not name production, an empty `COLLAB_TOKENS`
and an unwritable data directory among them, fire in every environment.

Build:

- `[dependency-lock] FAILED: ... package-lock.json is missing`: the image build
  checks the committed lock before installing anything. Restore the reviewed
  lock from version control, or regenerate it from the exact public manifest
  with the supported Node/npm version and review the full diff. Never hand-write
  or vendor a lock.
- `set UPSTREAM_URL to your provider endpoint`: Compose refuses before any
  container starts, because `docker-compose.yml` marks that variable required.
  It comes from the root `.env`, which `.env.example` already fills in.

Collaboration server:

- `Set COLLAB_TOKENS to at least one accepted token (comma separated).`: the
  token list is empty. This one is not environment-dependent, and with Compose
  the value comes from `secrets/collab_tokens`, not from the environment.
- `Refusing to start with placeholder tokens in production`, followed by the
  offending values: they were copied out of `.env.example`. Replace them with
  `openssl rand -hex 32` output.
- `Refusing production secrets shorter than 32 UTF-8 bytes`, followed by the
  settings that failed: same fix. `openssl rand -hex 32` satisfies every token
  rule at once. Secret values themselves are never logged.
- `Refusing the permissive authorizeDocument policy in production.`: the shipped
  starter policy is still in `index.mjs`, recognized by its
  `authorizeDocument.isPermissiveStarter = true;` marker. Replace the callback
  and delete that line with it, or set
  `COLLAB_ALLOW_TOKEN_WIDE_DOCUMENT_ACCESS=1` for a deliberate single-tenant
  deployment.
- `SQLITE_PATH="/data/collab.sqlite" is not writable by this process.`: the
  process cannot write the database or create its sidecars beside it. Under
  Docker the cause is a `collab-data` volume still owned by root from an image
  that predates the non-root containers, and the README has the one-time
  ownership migration; on bare metal it is ordinary directory permissions. The
  refusal is deliberate: SQLite would otherwise fall back to read-only and every
  save would fail while the process looked healthy.
- `COLLAB_TOKENS and COLLAB_TOKENS_FILE are both set; use exactly one.`: a
  direct value and a mounted file both arrived. Compose uses the `_FILE` form,
  so clear the direct one.
- `Refusing to start unsigned webhooks in production.` or `Refusing an HTTP
  WEBHOOK_URL in production`: set `WEBHOOK_SECRET` and an HTTPS `WEBHOOK_URL`,
  or declare the exception with `WEBHOOK_ALLOW_UNSIGNED=1` or
  `WEBHOOK_ALLOW_INSECURE_HTTP=1` when an outer system provides authenticity or
  a trusted private transport.

AI proxy:

- `Refusing to start a hosted provider without PROVIDER_API_KEY in production.`:
  the bootstrap creates `secrets/provider_api_key` empty on purpose. Put the
  provider-issued key in it, use `PROVIDER=none` for a local model, or start
  only the collaboration service (`docker compose up --build collab-server`).
- `Refusing to start without AI_TOKENS in production.`: no caller tokens.
  Generate one, or set `AI_ALLOW_UNAUTHENTICATED=1` when a gateway in front of
  the process, or a replaced `authorizeRequest`, authenticates every request.
- `Refusing to start with placeholder tokens in production` and `Refusing
  AI_TOKENS shorter than 32 UTF-8 bytes in production.`: same fix as the
  collaboration server's token guards.
- `Refusing an HTTP UPSTREAM_URL for a hosted provider in production`: the API
  key and the prompts would travel unencrypted. Use HTTPS, or
  `UPSTREAM_ALLOW_INSECURE_HTTP=1` for an explicitly trusted private transport.

Either service, on a port that is taken or a host that does not exist:
`[collab] Could not listen on 0.0.0.0:1234: the port is already in use` and
`[ai-proxy] Could not listen on 127.0.0.1:1250: the host address is not
available on this machine`. Change `PORT`, `REST_PORT` or `HOST`, or stop
whatever holds the port.

It starts but warns:

- `[collab] SQLite journal_mode is "delete", not WAL: the online backup in
  OPERATIONS.md can restart indefinitely on a busy server.`: the filesystem
  under `/data` refused WAL, which network mounts commonly do. The consistent
  backup below can then restart forever on a busy server, so move the database
  to a filesystem that supports WAL.
- `[collab] N token(s) appear in both COLLAB_TOKENS and COLLAB_READONLY_TOKENS`:
  they resolve to read-only on both surfaces. Remove them from `COLLAB_TOKENS`.
- `[collab] authorizeDocument is the permissive placeholder`: the marker is
  still there and `COLLAB_ALLOW_TOKEN_WIDE_DOCUMENT_ACCESS=1` is declaring that
  deliberately.

## Health and integrity

```bash
docker compose ps
docker compose exec -T collab-server node scripts/sqlite-maintenance.mjs check /data/collab.sqlite
```

The second command runs SQLite's full `integrity_check` against the live file.
It is read-only. Treat anything except `OK` as an incident: stop writes, retain
the volume, and restore a verified backup. Container health means the process
answers correctly; it does not replace a database integrity check or an actual
client/API smoke test.

## Consistent backup

Do not copy `collab.sqlite` directly while the service runs. The server puts the
database in WAL mode at startup, so committed pages live in `collab.sqlite-wal`
until a checkpoint folds them in, and a copy of the main file alone silently
omits recent edits. That is why `/data` holds `collab.sqlite`,
`collab.sqlite-wal` and `collab.sqlite-shm` while the service runs. The
maintenance command uses SQLite's online backup API and verifies the result. The
temporary snapshot is created on `/data`, not the deliberately 64 MiB `/tmp`;
ensure the volume has at least one additional database-size worth of free space,
plus room for a WAL that grows between checkpoints, before starting.

```bash
set -eu
umask 077
mkdir -p backups
backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_path="backups/collab-${backup_stamp}.sqlite"
container_path="/data/.collab-backup-export-${backup_stamp}-$$.sqlite"
if [ -e "$backup_path" ]; then
  echo "Refusing to overwrite $backup_path" >&2
  exit 1
fi

docker compose exec -T collab-server \
  node scripts/sqlite-maintenance.mjs backup "$container_path" /data/collab.sqlite
docker compose cp "collab-server:$container_path" "$backup_path"
chmod 600 "$backup_path"
test -s "$backup_path"
docker compose exec -T collab-server rm -f "$container_path"
```

Keep backups encrypted, access-controlled, off the Docker host and under a
documented retention schedule. A backup contains document contents, comments,
versions and metadata in plaintext. Record the application Git revision next to
it, but never put the backup itself in Git.

The active SQLite database, WAL and SHM files in the Docker volume are also
plaintext at rest. Use an encrypted host disk or encrypted volume when your
threat model or policy requires storage encryption; application-level TLS does
not encrypt files on disk.

The imports below intentionally stream bytes through a non-TTY one-off
container. Docker copy semantics make a destination inside a container
[root-owned by default](https://docs.docker.com/reference/cli/docker/container/cp/),
but this image runs as uid 1000. Streaming preserves binary SQLite bytes and
creates the file as the unprivileged service user with mode `600`; no-clobber
mode refuses an existing destination.

Verify a copied backup independently:

```bash
set -eu
backup_path='backups/collab-YYYYMMDDTHHMMSSZ.sqlite'
verify_path="/data/.collab-backup-verify-$(date -u +%Y%m%dT%H%M%SZ)-$$.sqlite"
docker compose run --rm --no-deps -T \
  --entrypoint sh collab-server \
  -ec 'umask 077; set -C; cat > "$1"' sh "$verify_path" < "$backup_path"
docker compose exec -T collab-server \
  node scripts/sqlite-maintenance.mjs check "$verify_path"
docker compose exec -T collab-server rm -f "$verify_path"
```

If the integrity check fails, keep the unique verification file while
diagnosing it, then rerun the final removal command with that exact path.

Periodically perform the full restore drill below on an isolated Compose project.
A backup that has never been restored is only an assumption.

## Restore and automatic rollback copy

Restoring replaces live data, so schedule downtime and first preserve a fresh
backup. The restore command refuses to run unless you explicitly state that the
service is offline. Before replacement it creates a unique, verified SQLite
backup of the old database, including committed WAL data, inside `/data`. It never
overwrites an existing rollback file. At peak, `/data` holds the live database,
restore input, verified candidate and rollback; budget roughly three additional
database-size files so a full volume cannot interrupt the operation.

```bash
set -eu
backup_path='backups/collab-YYYYMMDDTHHMMSSZ.sqlite'
restore_input="/data/restore-input-$(date -u +%Y%m%dT%H%M%SZ)-$$.sqlite"

docker compose stop --timeout 30 collab-server
docker compose run --rm --no-deps -T \
  --entrypoint sh collab-server \
  -ec 'umask 077; set -C; cat > "$1"' sh "$restore_input" < "$backup_path"
docker compose run --rm --no-deps \
  --env COLLAB_MAINTENANCE_OFFLINE=1 \
  --entrypoint node collab-server \
  scripts/sqlite-maintenance.mjs restore \
  "$restore_input" /data/collab.sqlite
docker compose up --detach --wait collab-server
docker compose exec -T collab-server \
  node scripts/sqlite-maintenance.mjs check /data/collab.sqlite
docker compose exec -T collab-server rm -f "$restore_input"
```

The command prints the exact `/data/collab.sqlite.before-restore-*` rollback
path. Keep it until users verify current documents and versions. Remove that
rollback file only after the retention decision; the command block removes its
unique restore input after the integrity check succeeds. Replacement also
removes the live database's `-journal`, `-wal` and `-shm` sidecars, and the
server recreates the WAL pair on its next start.

A restore that fails after the rollback copy exists names that copy in the
failure itself: `[sqlite-maintenance] FAILED: Restore failed after the rollback
copy was created: <cause>. Previous database preserved at <path>.` The previous
database is recoverable from that one line, so keep it.

If an import or restore step fails, keep the collaboration service stopped and
retain the unique input while diagnosing it. Remove only that exact path when
you no longer need it:

```bash
restore_input='/data/restore-input-YYYYMMDDTHHMMSSZ-PID.sqlite'
docker compose run --rm --no-deps --entrypoint rm collab-server \
  -f -- "$restore_input"
```

If restore refuses because the current database cannot produce a verified
rollback, do not force deletion. Preserve the whole volume or its raw database,
WAL and SHM files for recovery, then restore into a fresh isolated volume.

## Upgrade and rollback

1. Before the first tagged release, choose and record the full trusted commit SHA. After tagged releases begin, read the release notes and dependency or lock changes. Never hand-edit the lock.
2. Create and verify a backup as above.
3. Record the current Git revision with `git rev-parse HEAD`.
4. Fetch the desired trusted revision and review its diff before switching.
5. Validate configuration with `docker compose config --quiet`.
6. Build locally with `docker compose build --pull`; no image is published.
7. Replace services with `docker compose up --detach --wait`.
8. Check SQLite integrity, authenticate through the REST API, and open a real
   collaborative document through the same reverse proxy users use.

If the new application is unhealthy, retain its logs, switch back to the exact
recorded revision, rebuild, and start it. Restore the pre-upgrade database only
when the release performed an incompatible data migration or validation proves
data changed incorrectly; application rollback alone is safer when data is
still compatible.

Never upgrade by changing a Docker tag in a running host. The Dockerfiles pin
both Node tag and digest, the npm lock pins transitive packages, and CI is where
those bytes are tested together.

## Data deletion

`docker compose down` removes containers and networks but preserves the named
volume. `docker compose down --volumes` destroys every collaboration document,
comment and version in that project. It is intentionally not part of normal
shutdown or upgrade:

```bash
# Destructive and not recoverable unless you have a verified external backup:
docker compose down --volumes
```

The reference REST API has no single-document DELETE route. Do not guess at the
Hocuspocus SQLite schema or delete only a visible document row: version sibling
documents and related state can remain. For selective deletion, add an
authenticated tenant-aware administrative operation to your fork, test it on a
restored copy, and define whether versions/backups must also be erased.

Deleting the live volume does not delete exported backups, reverse-proxy logs,
webhook receiver data or provider-side AI records. Track each separately in your
retention and erasure procedure.

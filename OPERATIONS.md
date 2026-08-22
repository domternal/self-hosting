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

Create the default host files and generate independent high-entropy caller
tokens:

```bash
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
```

The subshell refuses to overwrite any existing source file. Edit or rotate an
existing deployment deliberately instead of rerunning initialization over it.

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

For a zero-downtime caller-token rotation, put the old and new tokens in the
same comma-separated source file, recreate that service, move clients to the
new token, remove the old token, then recreate the service again. Recreating
remounts the current host file even when a secret manager replaces it atomically:

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
or private gateway is ready in front of them. At that edge, cap simultaneous
connections, requests per authenticated user and source, and aggregate request
body throughput for both services. Keep gateway body limits at or below the
application limits unless the application limits are changed and retested.

The application bounds each websocket frame, REST body and AI request, while
Compose limits process count. Those controls do not cap the memory, sockets or
provider spend created by many individually valid requests at once. Configure
idle and upstream timeouts at the gateway too, but keep them long enough for
expected collaboration sessions and streaming AI responses.

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

Do not copy `collab.sqlite` directly while the service runs. Committed pages can
still live in SQLite's WAL, so a plain file copy can silently omit recent edits.
The maintenance command uses SQLite's online backup API and verifies the result.
The temporary snapshot is created on `/data`, not the deliberately 64 MiB
`/tmp`; ensure the volume has at least one additional database-size worth of
free space before starting.

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

The imports below intentionally stream bytes through a non-TTY one-off
container. Docker copy semantics make a destination inside a container
[root-owned by default](https://docs.docker.com/reference/cli/docker/container/cp/),
but this image runs as uid 1000. Streaming preserves binary SQLite bytes and
creates the file as the unprivileged service user with mode `600`; no-clobber
mode refuses an existing destination.

Verify a copied backup independently:

```bash
set -eu
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
unique restore input after the integrity check succeeds.

If an import or restore step fails, keep the collaboration service stopped and
retain the unique input while diagnosing it. Remove only that exact path when
you no longer need it:

```bash
docker compose run --rm --no-deps --entrypoint rm collab-server \
  -f -- "$restore_input"
```

If restore refuses because the current database cannot produce a verified
rollback, do not force deletion. Preserve the whole volume or its raw database,
WAL and SHM files for recovery, then restore into a fresh isolated volume.

## Upgrade and rollback

1. Read release notes and dependency/lock changes. Never hand-edit the lock.
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

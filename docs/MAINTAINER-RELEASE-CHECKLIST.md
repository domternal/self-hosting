# Maintainer release checklist

This public template consumes published packages; it must never smuggle private
workspace links or tarballs into a user-facing deployment.

## Blocking release order

At the time this hardening was prepared, these exact public packages were not
yet available from npm:

- `@domternal-pro/core@1.0.0`
- `@domternal-pro/extension-comments@1.0.0`

That is the single intentional external blocker. Until both exist, do not invent
`collab-server/package-lock.json`, vendor private tarballs, weaken `npm ci`, or
claim that Docker/E2E passed. The dependency-free policy and syntax suite
remains valid. The `dependency-lock` and `containers` CI jobs report as skipped
only while at least one exact Pro release is unavailable and the lock has never
existed in reachable default-branch or prior-push history. The static job fails
closed if either history or public-registry status cannot be verified. Once
both releases are public, a missing lock fails CI even if reachable history was
rewritten.

Before publishing, protect the default branch with a ruleset that disallows
force pushes and restricts bypass permission to the smallest practical
maintainer group. CI also checks prior-push history and exact public npm release
status, but repository protection prevents destructive history rewrites at the
source.

After publishing both packages:

1. Confirm their npm manifests, `dist`, `LICENSE.md` and
   `THIRD-PARTY-LICENSES.md` are present with `npm pack --dry-run` or an isolated
   registry install.
2. Run `nvm use`, then from `collab-server/` use Node 22.23.2's bundled npm to
   generate a real registry lock with
   `npm install --package-lock-only --ignore-scripts --strict-peer-deps`.
3. Review that every root specifier remains exact and that no `file:`, `link:`,
   `workspace:`, private registry URL or authentication material entered the
   lock.
4. Run `node scripts/require-lockfile.mjs`, then in `collab-server/` run
   `npm ci --omit=dev --ignore-scripts --strict-peer-deps`, `npm audit signatures`,
   `npm audit --omit=dev --audit-level=high`, then
   `npm rebuild better-sqlite3 --omit=dev --build-from-source` and
   `npm ls --omit=dev --all`.
5. Run `node collab-server/scripts/check-artifacts.mjs collab-server` and the
   full unit suite.
6. Run Docker build checks, native amd64 and arm64 builds, ephemeral container
   E2E, and both Trivy policies exactly as CI does.
7. Commit the reviewed `collab-server/package-lock.json`. It is part of the
   deployable product and must never return to `.gitignore`.

## Every template release

- All `uses:` entries remain pinned to full commit SHAs and checkout never
  persists credentials.
- Node remains an exact supported tag plus digest; a major change needs explicit
  compatibility proof on both architectures. The read-only dependency update
  report checks the shared `node` tag and digest across all three Docker
  directories; never merge a partial bump that leaves production and E2E on
  different base bytes.
- Docker contexts remain default-deny and no `.env`, database, backup, Git data
  or unrelated source reaches a builder.
- Compose continues to expose only loopback by default, mount secrets as files,
  keep `/data` writable, and apply read-only/no-capability/no-new-privileges
  policy to every runtime.
- CI builds and scans but contains no registry login, image push, npm publish or
  release command.
- Restore is tested from a consistent backup and proves the automatic rollback
  retains committed WAL data.
- Documentation names any remaining limitation honestly.

## Settings for the repository you run this in

- Keep the repository marked as a GitHub template, since the README opens by
  telling readers to start from it, and keep Issues enabled: the checked-in
  chooser carries no blank form and routes reports to the central tracker, so
  disabling Issues removes the routing rather than the noise.
- Enable private vulnerability reporting, Dependency graph, Dependabot alerts,
  Dependabot malware alerts, Secret Protection and push protection. Keep
  Dependabot security updates, grouped security updates and every rule that
  opens an automatic pull request disabled. The checked-in zero limits keep
  routine Dependabot version PRs disabled as well.
- Keep GitHub CodeQL default setup disabled. This repository commits an
  advanced CodeQL workflow, and GitHub rejects advanced SARIF uploads while
  default setup is enabled.
- Require a check only after it has produced a real success, because GitHub
  offers a check name only after it has run once. Start with
  `CI / Static policy and syntax`, `CodeQL / JavaScript analysis` and
  `Dependency review / dependency-review`. Once the registry lock is committed
  and the lock-dependent jobs stop skipping, also require
  `CI / Frozen npm dependency and provenance gates`, `CI / Containers (amd64)`
  and `CI / Containers (arm64)`. Code scanning, dependency review and the
  `ubuntu-24.04-arm` runner depend on your plan and repository visibility.
- Keep Actions workflow permissions read-only by default. Checkout steps must
  set `persist-credentials: false`; only the CodeQL analysis job receives
  `security-events: write` for its SARIF upload.
- Enable GitHub Actions web or email notifications, preferably only for failed
  workflows. The weekly dependency update report intentionally fails when it
  finds a new version, an acknowledged incompatible update or cannot complete
  every upstream lookup. The two Pro package lookups remain incomplete until
  those packages are public. Review its job summary manually; never make it a
  required pull-request check. GitHub automatically disables scheduled
  workflows in a public repository after 60 days without repository activity;
  re-enable this workflow from the Actions tab if that happens.

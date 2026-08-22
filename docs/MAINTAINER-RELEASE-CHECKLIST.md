# Maintainer release checklist

This public template consumes published packages; it must never smuggle private
workspace links or tarballs into a user-facing deployment.

## Mirror ownership

The shared runtime and behavior originate in
`domternal-pro/examples/self-hosting/`, where they are implemented and tested
first. This repository is their standalone user distribution, not a second
independent implementation. Do not make a permanent shared-source fix only
here: port it to the Pro example first, then copy the shared file back to the
same relative public path byte-for-byte.

Some files intentionally remain different. Paired variants preserve the same
behavior while translating the Pro pnpm workspace build into this repository's
exact published-package npm install. Public-only CI, lock, policy and release
files remain owned here; Pro-only workspace deploy files remain in Pro. The
normative path classes and reasons are in the Pro
`tests/third-party-notices/mirror-policy.mjs`, with the full workflow in its
README under "Self-hosting source of truth and public mirror."

The Pro mirror checker detects drift but never copies, rewrites, classifies or
repairs a file. After a coordinated local sync, update and review the v4 hash
manifest from the Pro checkout, run both repositories' checks, and land the
public commit before the matching Pro commit because hosted Pro CI compares
against public `main`.

## Blocking release order

At the time this hardening was prepared, these exact public packages were not
yet available from npm:

- `@domternal-pro/core@0.1.0`
- `@domternal-pro/extension-comments@0.1.0`

That is the single intentional external blocker. Until both exist, do not invent
`collab-server/package-lock.json`, copy a Pro workspace lock, vendor private
tarballs, weaken `npm ci`, or claim that Docker/E2E passed. The dependency-free
policy and syntax suite remains valid; the `dependency-lock` CI job explains and
fails at this boundary.

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
- The public/Pro mirror policy classifies every path explicitly and all truly
  shared source remains byte-identical.
- Restore is tested from a consistent backup and proves the automatic rollback
  retains committed WAL data.
- Documentation names any remaining limitation honestly.

## GitHub repository setup

- Enable the repository's template setting so the README's `Use this template`
  instruction matches GitHub's interface. Keep Issues enabled only as a routed
  chooser: blank reports stay disabled and every public contact link leads to
  the central tracker, documentation or private security policy.
- Enable private vulnerability reporting, Dependency graph, Dependabot alerts,
  Dependabot malware alerts, Secret Protection and push protection. Keep
  Dependabot security updates, grouped security updates and every rule that
  opens an automatic pull request disabled. The checked-in zero limits keep
  routine Dependabot version PRs disabled as well.
- Keep GitHub CodeQL default setup disabled. This repository commits an
  advanced CodeQL workflow, and GitHub rejects advanced SARIF uploads while
  default setup is enabled.
- While the repository is private, confirm that the organization plan enables
  code scanning, dependency review and the `ubuntu-24.04-arm` runner. These
  capabilities are generally available once the repository is public, but a
  required check must not be configured until it has produced a real success.
- After each check has produced a real success, initially require
  `CI / Static policy and syntax`, `CodeQL / JavaScript analysis` and
  `Dependency review / dependency-review` for `main`. When the public Pro
  packages and registry lock exist, also require
  `CI / Frozen npm dependency and provenance gates`, `CI / Containers (amd64)`
  and `CI / Containers (arm64)`. Keep merge-queue checks required when merge
  queue is enabled; GitHub only offers a check name after it has run once.
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

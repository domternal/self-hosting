# Maintainer release checklist

This public template installs only public third-party packages. The two MIT
servers must never gain a Domternal Pro dependency or import, a private
workspace link, a private tarball or a private registry resolution.

## Publication model

This repository is published as source under the MIT license. Making the
repository public and creating a versioned GitHub release are separate actions:

- Making the repository public exposes the reviewed `main` branch and its Git
  history. It does not require a Git tag or a GitHub Release.
- A formal versioned release identifies one approved `main` commit with an
  immutable, signed, annotated `vX.Y.Z` tag and a GitHub Release containing the
  release notes.
- Neither action publishes an npm package or a container image. CI may build
  local images for validation, but maintainers must not add an npm publish,
  registry login, image push or package-registry release step.

The first public release remains on Node 22.23.2. Do not combine the initial
publication with a Node 24 migration. Treat Node 24 as a later, separate change
that updates every Node declaration and Docker tag and digest together, then
proves native SQLite, amd64 and arm64 compatibility before merge.

## First public publication without a version tag

Use this path when the goal is to make the source template available without
claiming a formal versioned release:

1. Merge all approved changes into `main`. Confirm the local checkout is clean,
   is on `main`, and matches the intended `origin/main` commit. Record its full
   commit SHA.
2. Use `nvm use` and confirm the selected runtime is Node 22.23.2. Complete the
   frozen dependency review and every template release checklist below.
3. Confirm the repository contains no real secrets, private packages, private
   registry references, customer data, databases, backups or unrelated build
   artifacts. Confirm the MIT license and public documentation are present.
4. Configure the GitHub repository settings listed below. Settings available
   only to public repositories may be enabled immediately after the visibility
   change.
5. Change the repository visibility to public. Do not create or push a version
   tag merely to make the repository public.
6. Verify the repository through an anonymous browser session and a fresh
   anonymous clone. Confirm the default branch, template status, MIT license,
   README links, issue routing and private vulnerability reporting behave as
   documented.
7. Manually dispatch `CI` and `CodeQL` on the public `main` commit. Require a
   successful hosted amd64 container job, hosted arm64 container job, blocking
   Trivy scans for both images on both architectures, the frozen dependency
   job, static policy checks and CodeQL. Do not waive a missing architecture or
   a failed Trivy policy for the first public publication.
8. After those check names have produced a real success, add the required checks
   and branch rules described below. The repository is then publicly usable at
   the recorded commit even though no version tag exists.

## Formal versioned GitHub source release

Use this path when a specific public source revision should be represented as
`vX.Y.Z`:

1. Prepare release notes before merging the release pull request. At minimum,
   record the user-visible changes, dependency or lock changes, compatibility
   requirements, migrations, backup and rollback guidance, known limitations,
   supported Node version and the full candidate commit SHA. State explicitly
   that the release provides source and does not publish npm packages or
   container images.
2. Merge the reviewed pull request into `main`. Confirm the checkout is clean,
   the candidate is reachable from `origin/main`, and local `main` exactly
   matches that approved remote commit.
3. Run the complete local dependency, policy, unit, artifact and container
   checks on Node 22.23.2. Do not tag a working tree, feature branch or an
   unreviewed commit.
4. Wait for the hosted checks on that exact `main` commit. The static policy,
   frozen dependency, CodeQL, hosted amd64 container, hosted arm64 container and
   blocking Trivy checks must all succeed. Dependency review must have succeeded
   on the release pull request.
5. Synchronize the merged shared runtime into the Domternal Pro integration
   mirror. From the Pro repository, refresh the reviewed mirror manifest with
   `node tests/third-party-notices/check.mjs --update-mirror-manifest`, review
   the resulting diff, then run `pnpm test:third-party-notices` and
   `node tests/third-party-notices/check-mirror.mjs`. Complete this coordinated
   Pro change before announcing the source release.
6. Confirm `vX.Y.Z` has never been used. Run the release preflight, then create
   a signed, annotated tag that points to the full approved `main` SHA, verify
   its signature locally, and push only that tag. Replace `vX.Y.Z` with the
   intended version and preserve the recorded full SHA:

   ```bash
   git fetch origin --tags
   git switch main
   git pull --ff-only
   git status --short
   release_sha="$(git rev-parse HEAD)"
   test "$release_sha" = "$(git rev-parse origin/main)"
   git tag --list 'vX.Y.Z'
   node scripts/check-policy.mjs --release-tag vX.Y.Z
   git tag -s -a vX.Y.Z "$release_sha" -m 'Self-hosting vX.Y.Z'
   git tag -v vX.Y.Z
   git push origin vX.Y.Z
   ```

   `git status --short` must produce no output and `git tag --list` must confirm
   the intended version is unused before the tag is created. Never move,
   overwrite, delete and recreate, or reuse a published release tag. If a
   correction is needed, publish a new version.
7. Create the GitHub Release from that exact tag and use the reviewed release
   notes. Verify the displayed tag, commit, signature and automatically generated
   source archives. Do not attach unreviewed binaries or publish images,
   packages or registry artifacts as part of this procedure.
8. Recheck the public release from an anonymous session. Record the tag, full
   commit SHA, release URL and hosted workflow run URLs in the maintainer release
   record.

## Frozen dependency review

Protect the default branch with a ruleset that disallows force pushes and
restricts bypass permission to the smallest practical maintainer group.

For every dependency change:

1. Run `nvm use`, then from `collab-server/` use Node 22.23.2's bundled npm to
   generate a registry lock with
   `npm install --package-lock-only --ignore-scripts --strict-peer-deps`.
2. Review that every root specifier remains exact and that no `file:`, `link:`,
   `workspace:`, private registry URL or authentication material entered the
   lock.
3. Run `node ../scripts/check-commercial-boundary.mjs` from `collab-server/`
   and confirm both server manifests and source trees remain independent from
   Domternal Pro packages.
4. From the repository root, run `node scripts/require-lockfile.mjs`, then in
   `collab-server/` run
   `npm ci --omit=dev --ignore-scripts --strict-peer-deps`, `npm audit signatures`,
   `npm audit --omit=dev --audit-level=high`, then
   `npm rebuild better-sqlite3 --omit=dev --build-from-source` and
   `npm ls --omit=dev --all`.
5. From the repository root, run
   `node collab-server/scripts/check-artifacts.mjs collab-server` and the full
   unit suite. This includes the local thread garbage-collection and commercial
   boundary tests.
6. Run Docker build checks, native amd64 and arm64 builds, ephemeral container
   E2E, and both Trivy policies exactly as CI does.
7. Commit the reviewed `collab-server/package-lock.json`. It is part of the
   deployable product and must never be optional or return to `.gitignore`.

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
  offers a check name only after it has run once. Require
  `CI / Static policy and syntax`, `CodeQL / JavaScript analysis`,
  `Dependency review / dependency-review`,
  `CI / Frozen npm dependency and provenance gates`, `CI / Containers (amd64)`
  and `CI / Containers (arm64)`. Code scanning, dependency review and the
  `ubuntu-24.04-arm` runner depend on your plan and repository visibility.
- Keep Actions workflow permissions read-only by default. Checkout steps must
  set `persist-credentials: false`; only the CodeQL analysis job receives
  `security-events: write` for its SARIF upload.
- Enable GitHub Actions web or email notifications, preferably only for failed
  workflows. The weekly dependency update report intentionally fails when it
  finds a new version, an acknowledged incompatible update or cannot complete
  every upstream lookup. Review its job summary manually; never make it a
  required pull-request check. GitHub automatically disables scheduled
  workflows in a public repository after 60 days without repository activity;
  re-enable this workflow from the Actions tab if that happens.

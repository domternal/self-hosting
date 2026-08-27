# Contributing

Thank you for helping improve the Domternal self-hosting reference services.

## Choose the right channel

- Follow [SUPPORT.md](./SUPPORT.md) for setup questions and ordinary defects.
- Follow [SECURITY.md](./SECURITY.md) for vulnerabilities. Never disclose a
  security problem in a public issue or pull request.
- Never include credentials, customer data, production databases, backups or
  private logs in a report, fixture or commit.

Issues for this repository are intentionally centralized in the public
[`domternal/domternal` tracker](https://github.com/domternal/domternal/issues).
Use the dedicated
[self-hosting report form](https://github.com/domternal/domternal/issues/new?template=self_hosting_bug_report.yml)
for defects and link that issue from a pull request when one exists.

## Source-of-truth workflow

This public MIT repository is the canonical runnable source for the shared
self-hosting runtime. The private Pro repository keeps an integration mirror at
`domternal-pro/examples/self-hosting/` so the same runtime is exercised by Pro
release and end-to-end tests. Shared MIT runtime changes are reviewed here
first, then synchronized into that mirror and checked by the byte-parity and
commercial-boundary gates. Neither copy may acquire a Domternal Pro package,
key, activation API or license environment dependency.

The two repositories intentionally use different standalone and workspace
packaging. A Pro-only build or test overlay is permitted only where the mirror
policy classifies and documents it explicitly; it must not change the shared
runtime behavior. Public-only CI, documentation and packaging changes can be
reviewed directly in this repository.

This coordination rule applies to upstream contributions. Once you generate
your own repository from this template, your fork belongs to you and may be
adapted independently for your deployment.

## Pull requests

Keep each pull request focused and explain:

- the problem and intended behavior
- whether the change affects shared runtime code or only this public template
- the security and operational impact
- the validation you performed
- any documentation users must update in their own deployments

Run the dependency-free checks before submitting:

```bash
node --test tests/*.test.mjs
docker compose --file docker-compose.yml config --quiet
docker compose \
  --file docker-compose.yml \
  --file tests/docker-compose.e2e.yml \
  config --quiet
```

Also run the frozen install, artifact, Docker and container checks described in
[`docs/MAINTAINER-RELEASE-CHECKLIST.md`](./docs/MAINTAINER-RELEASE-CHECKLIST.md).

Contributions to MIT-licensed files are submitted under this repository's MIT
license. Neither reference server installs or imports a Domternal Pro package.

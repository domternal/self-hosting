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

The shared runtime and behavior originate in the private Pro example at
`domternal-pro/examples/self-hosting/`. This repository is the reviewed public
distribution. External contributors do not need access to the Pro repository:
describe the desired behavior and provide a focused public reproduction, and a
maintainer will coordinate any required Pro-first implementation and mirror
sync.

Do not be surprised if a maintainer recreates or resynchronizes a shared-source
change before merging it here. That preserves the tested Pro source of truth
without losing the contribution or its attribution. Public-only CI,
documentation and packaging changes can be reviewed directly in this
repository.

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

When the public registry lock exists, also run the frozen install, artifact,
Docker and container checks described in
[`docs/MAINTAINER-RELEASE-CHECKLIST.md`](./docs/MAINTAINER-RELEASE-CHECKLIST.md).

Contributions to MIT-licensed files are submitted under this repository's MIT
license. Installed `@domternal-pro` packages retain their separate commercial
license.

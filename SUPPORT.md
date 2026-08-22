# Support

## Setup and operation

Start with the repository [README](./README.md), then use the service-specific
guides in [`collab-server/`](./collab-server/README.md) and
[`ai-proxy/`](./ai-proxy/README.md). Backup, restore, upgrade and rollback
procedures are in [`OPERATIONS.md`](./OPERATIONS.md). The complete product guide
is in the [Domternal self-hosting documentation](https://domternal.dev/v1/pro/self-hosting/).

## Questions and defects

This repository keeps ordinary reports in one public place. Search or open an
issue using the central
[`domternal/domternal` Pro report form](https://github.com/domternal/domternal/issues/new?template=pro_bug_report.yml)
and identify the affected self-hosting service and revision. Select `Not sure`
for the package and `Not framework-specific` when the problem belongs to a
reference server. Issues are disabled here to avoid splitting the same support
history across repositories.

Include a minimal reproduction, relevant sanitized logs, the host architecture,
Node or Docker version and the exact command that failed. Never include tokens,
provider keys, customer documents, databases, backups or other private data.

## Security

Do not report a vulnerability through a public issue. Follow
[`SECURITY.md`](./SECURITY.md) and report it privately to
[security@domternal.dev](mailto:security@domternal.dev).

## Support scope

The MIT-licensed reference services are a starting point that deployment owners
operate, secure and adapt for their own infrastructure. Domternal Pro support
plans cover the editor packages, not custom infrastructure, reverse proxies,
identity systems, databases or forks of this template.

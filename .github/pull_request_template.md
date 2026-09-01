# Summary

<!-- Short summary of the problem and the intended behavior. -->

<!-- Fill in the sections that apply and delete the ones that do not. -->

# Features

<!-- Which features were added. -->

# Fix

<!-- What was fixed and which bug it resolves. -->

# Changes

<!-- Which implementation, deployment or documentation changes were made. -->

# Verified

<!-- List the exact checks you ran and any relevant checks you could not run. -->

- [ ] I ran the relevant repository checks.
- [ ] I updated user or operational documentation when behavior changed.

# Self-hosting review

- [ ] This changes only public CI, packaging or documentation.
- [ ] This affects shared runtime code mirrored into the Pro integration copy.
- [ ] A related `domternal/domternal` issue is linked when one exists.
- [ ] I included no credentials, customer data, databases, backups or private logs.
- [ ] This does not publicly disclose a vulnerability. Security reports follow `SECURITY.md`.

Maintainers land shared runtime behavior here first, then synchronize the Pro
integration mirror and refresh its reviewed mirror manifest before the matching
Pro change or release. Contributors do not need private repository access.

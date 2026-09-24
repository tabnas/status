# ci/

No scripts live here. The workflows in `.github/workflows/` run the
`npm` scripts and the files under `collector/`, `site/` and `scripts/`
directly.

To change CI, edit `.github/workflows/` in a reviewed pull request.
Session credentials push workflow files (admin `DECISIONS.md` ADR-8, as
amended 2026-09-24), so staging a workflow here first for a maintainer
to promote is optional. Where admin keeps a template for the file
(`rollout/workflows/status__<file>`, today for `status.yml` and
`deps-gate.yml`), mirror the change there at the same time: admin
`scripts/verify.sh` compares the template with the deployed copy, and a
maintainer's next `rollout/apply-workflows.sh --apply` would push the old
text back. Sessions still cannot push tags, so a maintainer pushes any tag
that a tag-triggered workflow needs.

## Promoted, 2026-09-22

`workflows/docs.yml`, the whole prose gate (`npm test`, then Vale and
the recorded counts), is now `.github/workflows/docs.yml`, moved by the
rollout script rather than edited. Nothing is pending. Read the workflow
itself rather than a description of it here.

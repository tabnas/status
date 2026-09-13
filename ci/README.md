# ci/

Staging area for GitHub Actions workflow changes.

This directory exists because session credentials cannot write
`.github/workflows/*` — see admin `DECISIONS.md` ADR-8. To change CI:

1. Put the intended workflow file in `workflows/`.
2. A maintainer promotes it with the admin `rollout/apply-ci-folders.sh`
   script.

## Pending

- **`workflows/docs.yml`** — the prose gate: Vale over the reader-facing
  pages at the levels set in `.vale.ini`, on the file list
  `scripts/gated-docs.mjs` produces. See `docs/STYLE-GUIDE.md`.

  It needs no collection run and no secrets, and pins its own Vale
  version. Errors fail the job; warnings go to the run summary as a
  report. `make prose` runs the identical check locally.

  It also runs `npm test`, which is the gate's other half
  (`scripts/docs.test.mjs`). `status.yml` collects and deploys and runs
  no tests, so without that step the local half would be installed here
  and never reached, which is worse than not having one. Promoting this
  file is therefore what turns the whole gate on.

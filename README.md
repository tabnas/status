# tabnas/status

Public health & compliance dashboard for the
[tabnas](https://github.com/tabnas) organization, published via GitHub Pages.

## How it works

Everything is generated — nothing here is hand-edited.

1. **[`collector/collect.mjs`](collector/collect.mjs)** (Node, zero deps)
   sweeps every public org repo via the GitHub API and writes
   `data/report.json`: per-repo results against the org
   ["Definition of Done"](https://github.com/tabnas/.github/blob/main/GOVERNANCE.md) —
   CI status, shared-CI adoption, Renovate, Release Please, npm↔Go release
   drift, SHA-pinned actions, branch protection, docs.
2. **[`site/render.mjs`](site/render.mjs)** renders `data/report.json` into a
   static dashboard under `_site/`, plus a
   [shields.io endpoint badge](https://shields.io/badges/endpoint-badge)
   per repo at `_site/badges/<repo>.json`.
3. A scheduled workflow runs both daily and deploys `_site/` to GitHub Pages.

## Run locally

```bash
GITHUB_TOKEN=<any read token> node collector/collect.mjs
node site/render.mjs
open _site/index.html
```

## Badges

Each repo can show its compliance in its README:

```markdown
![tabnas standard](https://img.shields.io/endpoint?url=https://tabnas.github.io/status/badges/<repo>.json)
```

## Setup notes (one-time)

- **Pages:** repo *Settings → Pages → Source: GitHub Actions*.
- The default `GITHUB_TOKEN` covers all public data. Branch-protection
  reads show as *unknown* until an org fine-grained read token is added as
  the `STATUS_READ_TOKEN` secret (optional).

## Checks

| Column | Meaning |
| --- | --- |
| CI | Latest completed workflow run on the default branch succeeded |
| Shared CI | Repo calls the reusable `tabnas/.github` polyglot-ci workflow |
| Renovate | `renovate.json` present (extends the org preset) |
| Release Please | `release-please-config.json` present |
| Version sync | npm `@tabnas/<repo>` latest == latest `go/vX.Y.Z` tag |
| Pinned actions | All third-party action refs pinned to commit SHAs |
| Protection | Default branch has branch protection (needs org token to read) |

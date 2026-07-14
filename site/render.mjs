#!/usr/bin/env node
// Renders data/report.json into a static dashboard under _site/,
// plus shields.io endpoint badges at _site/badges/<repo>.json.
// Zero dependencies.

import { mkdir, writeFile, readFile, cp } from 'node:fs/promises'

const report = JSON.parse(await readFile('data/report.json', 'utf8'))

const CHECK_COLS = [
  ['ci_green', 'CI'],
  ['ci_caller', 'Shared CI'],
  ['renovate', 'Renovate'],
  ['release_please', 'Release Please'],
  ['sha_pinned', 'Pinned actions'],
  ['protected', 'Protection'],
  ['readme', 'README'],
  ['license', 'License'],
]

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function cell(v) {
  if (v === null || v === undefined) return '<td class="na">–</td>'
  return v ? '<td class="ok">✓</td>' : '<td class="bad">✗</td>'
}

function scoreColor(r) {
  if (!r.score || r.score.known === 0) return 'lightgrey'
  const ratio = r.score.pass / r.score.known
  return ratio === 1 ? 'brightgreen' : ratio >= 0.6 ? 'yellow' : 'red'
}

const rows = report.repos
  .map((r) => {
    if (r.error) {
      return `<tr><td><a href="https://github.com/${report.org}/${esc(r.repo)}">${esc(r.repo)}</a></td>
        <td colspan="${CHECK_COLS.length + 6}" class="bad">collect error: ${esc(r.error)}</td></tr>`
    }
    const drift =
      r.version_drift === null
        ? '<td class="na">–</td>'
        : r.version_drift
          ? `<td class="warn" title="npm ${esc(r.npm_version)} vs go ${esc(r.go_version)}">drift</td>`
          : '<td class="ok">✓</td>'
    const ci = r.ci
      ? `<a href="${esc(r.ci.url)}">${r.ci.conclusion === 'success' ? '✓' : '✗'}</a>`
      : '–'
    const count = (n, kind) =>
      `<td class="num ${n ? '' : 'na'}"><a href="https://github.com/${report.org}/${esc(r.repo)}/${kind}">${n ?? 0}</a></td>`
    return `<tr>
      <td><a href="https://github.com/${report.org}/${esc(r.repo)}">${esc(r.repo)}</a></td>
      <td class="tier tier-${esc(r.tier)}">${esc(r.tier)}</td>
      <td>${esc(r.npm_version ?? '–')} / ${esc(r.go_version ?? '–')}</td>
      ${drift}
      ${count(r.open_prs, 'pulls')}
      ${count(r.open_issues, 'issues')}
      <td class="${r.checks.ci_green === null ? 'na' : r.checks.ci_green ? 'ok' : 'bad'}">${ci}</td>
      ${CHECK_COLS.slice(1).map(([k]) => cell(r.checks[k])).join('\n      ')}
      <td class="score">${r.score.pass}/${r.score.known}</td>
    </tr>`
  })
  .join('\n')

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tabnas org status</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 2rem auto; max-width: 72rem; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  .meta { color: gray; font-size: .85rem; margin-bottom: 1rem; }
  .summary { font-size: 1rem; margin: .5rem 0 1.5rem; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
           padding: .35rem .5rem; text-align: center; }
  td:first-child, th:first-child { text-align: left; }
  th { position: sticky; top: 0; background: Canvas; }
  .ok   { color: #1a7f37; }
  .bad  { color: #cf222e; font-weight: 600; }
  .warn { color: #9a6700; font-weight: 600; }
  .na   { color: gray; }
  .tier { font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; }
  .tier-core { color: #8250df; font-weight: 700; }
  .score, .num { font-variant-numeric: tabular-nums; }
  a { color: inherit; }
</style>
</head>
<body>
<h1>Tabnas org status</h1>
<div class="meta">Generated ${esc(report.generated)} ·
  <a href="data.json">raw data</a> ·
  <a href="https://github.com/${esc(report.org)}/status">how this works</a></div>
<div class="summary"><strong>${report.summary.fully_compliant}</strong> of
  <strong>${report.summary.total}</strong> repositories fully compliant with the
  <a href="https://github.com/${esc(report.org)}/.github/blob/main/GOVERNANCE.md">org standard</a>.
  <strong>${report.summary.open_prs ?? 0}</strong> open PRs ·
  <strong>${report.summary.open_issues ?? 0}</strong> open issues across the org.</div>
<table>
<thead><tr>
  <th>Repo</th><th>Tier</th><th>npm / go version</th><th>Version sync</th>
  <th>Open PRs</th><th>Open issues</th>
  ${CHECK_COLS.map(([, label]) => `<th>${label}</th>`).join('')}
  <th>Score</th>
</tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`

await mkdir('_site/badges', { recursive: true })
await writeFile('_site/index.html', html)
await cp('data/report.json', '_site/data.json')

let badges = 0
for (const r of report.repos) {
  if (r.error || !r.score) continue
  await writeFile(
    `_site/badges/${r.repo}.json`,
    JSON.stringify({
      schemaVersion: 1,
      label: 'tabnas standard',
      message: `${r.score.pass}/${r.score.known}`,
      color: scoreColor(r),
    })
  )
  badges++
}

console.log(`Rendered _site/index.html + ${badges} badges`)

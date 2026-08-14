#!/usr/bin/env node
// Renders data/report.json into a static dashboard under _site/,
// plus shields.io endpoint badges at _site/badges/<repo>.json.
// Zero dependencies.

import { mkdir, writeFile, readFile, cp } from 'node:fs/promises'

const report = JSON.parse(await readFile('data/report.json', 'utf8'))

// Org "Definition of Done" checks, then the agent-experience ones (admin
// ADR-10/11). `title` is the column's tooltip: several of these are not
// self-explanatory from a two-word header, and a check nobody can interpret
// gets ignored. A trailing † marks a column that is reported but NOT scored —
// see the collector's `scored` array for why.
const CHECK_COLS = [
  ['ci_green', 'CI', 'Latest completed run on the default branch succeeded'],
  ['ci_caller', 'Shared CI', 'Calls the org shared polyglot-ci workflow'],
  ['renovate', 'Renovate', 'Dependency updates are automated'],
  ['sha_pinned', 'Pinned actions', 'Every third-party action is pinned to a full commit SHA'],
  ['protected', 'Protection', 'Default branch is protected'],
  ['readme', 'README', 'Has README.md'],
  ['license', 'License', 'Has a LICENSE file'],
  ['agents_md', 'AGENTS.md', 'Has an agent guide at AGENTS.md (plan B2/B3)'],
  ['plugin_descriptor', 'Descriptor',
    'Grammar plugins carry the generated tabnas.plugin.json (plan B1); “–” for repos that are not plugins'],
  ['error_codes', 'Codes documented †',
    'Every error code the descriptor declares is also documented in AGENTS.md; “–” when the repo has neither'],
  ['skills_linked', 'Agent tooling †',
    'AGENTS.md or README points an agent at @tabnas/skills or @tabnas/mcp'],
]

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function cell(v) {
  if (v === null || v === undefined) return '<td class="na">–</td>'
  return v ? '<td class="ok">✓</td>' : '<td class="bad">✗</td>'
}

// "YYYY-MM-DD HH:MM" in UTC. Explicitly UTC rather than the builder's local
// zone: this page is generated on a GitHub runner and read from anywhere, so a
// local-time stamp would mean a different instant to every reader. The literal
// Z is dropped from the cell and stated once in the column header.
function utcStamp(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().replace('T', ' ').slice(0, 16)
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
        <td colspan="${CHECK_COLS.length + 7}" class="bad">collect error: ${esc(r.error)}</td></tr>`
    }
    const drift =
      r.version_drift === null
        ? '<td class="na">–</td>'
        : r.version_drift
          ? `<td class="warn" title="npm ${esc(r.npm_version)} vs go ${esc(r.go_version)}">drift</td>`
          : '<td class="ok">✓</td>'
    const pub = utcStamp(r.npm_published_at)
    const pubCell = pub
      ? `<td class="pub"><time datetime="${esc(r.npm_published_at)}">${esc(pub)}</time></td>`
      : '<td class="na">–</td>'
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
      ${pubCell}
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
  .summary.note { font-size: .85rem; color: gray; margin-top: -1rem; }
  th[title] { cursor: help; }
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
  .score, .num, .pub { font-variant-numeric: tabular-nums; }
  /* Keep the stamp on one line — wrapped between date and time it reads as
     two values. The table already scrolls sideways when it must. */
  .pub { white-space: nowrap; }
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
<div class="summary note">Columns marked † are reported but not scored: they
  track agent-experience work still in progress, so a low count there is a
  to-do list rather than a regression. Hover any column header for what it
  checks.</div>
<table>
<thead><tr>
  <th>Repo</th><th>Tier</th><th>npm / go version</th><th>Version sync</th>
  <th>Last publish (UTC)</th>
  <th>Open PRs</th><th>Open issues</th>
  ${CHECK_COLS.map(([, label, title]) =>
    `<th${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</th>`).join('')}
  <th>Score</th>
</tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`

// --- self-hosted SVG badges (no third-party service like shields.io) -------
const HEX = {
  brightgreen: '#3ba51a', green: '#3ba51a', yellow: '#c9a400', red: '#d33',
  lightgrey: '#9f9f9f', blue: '#007ec6', go: '#00add8',
}
// Flat badge, self-contained SVG. Width is estimated from text length.
function badgeSvg(label, message, colorKey) {
  const color = HEX[colorKey] || colorKey || HEX.brightgreen
  const e = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  label = e(label); message = e(message)
  const cw = 6.6, pad = 10
  const lw = Math.round(label.length * cw + pad)
  const mw = Math.round(message.length * cw + pad)
  const w = lw + mw
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}: ${message}">
<title>${label}: ${message}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)">
<rect width="${lw}" height="20" fill="#555"/>
<rect x="${lw}" width="${mw}" height="20" fill="${color}"/>
<rect width="${w}" height="20" fill="url(#s)"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,Geneva,sans-serif" font-size="11">
<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
<text x="${lw / 2}" y="14">${label}</text>
<text x="${lw + mw / 2}" y="15" fill="#010101" fill-opacity=".3">${message}</text>
<text x="${lw + mw / 2}" y="14">${message}</text>
</g>
</svg>`
}

const INFRA_BADGE = new Set(['.github', 'status', 'admin'])

await mkdir('_site/badges', { recursive: true })
await writeFile('_site/index.html', html)
await cp('data/report.json', '_site/data.json')

let badges = 0
const put = async (name, svg) => { await writeFile(`_site/badges/${name}.svg`, svg); badges++ }
for (const r of report.repos) {
  if (r.error) continue
  // CI status
  const ci = r.checks.ci_green
  await put(`${r.repo}-ci`, badgeSvg('ci', ci === null ? 'no runs' : ci ? 'passing' : 'failing',
    ci === null ? 'lightgrey' : ci ? 'green' : 'red'))
  // npm version (package repos only)
  if (!INFRA_BADGE.has(r.repo)) {
    await put(`${r.repo}-npm`, badgeSvg('npm', r.npm_version ? `v${r.npm_version}` : 'unpublished',
      r.npm_version ? 'blue' : 'lightgrey'))
  }
  // go version
  if (r.go_version) await put(`${r.repo}-go`, badgeSvg('go', `v${r.go_version}`, 'go'))
  // org-standard compliance score + legacy JSON endpoint
  if (r.score && r.score.known) {
    await put(`${r.repo}-standard`, badgeSvg('tabnas standard', `${r.score.pass}/${r.score.known}`, scoreColor(r)))
    await writeFile(`_site/badges/${r.repo}.json`, JSON.stringify({
      schemaVersion: 1, label: 'tabnas standard', message: `${r.score.pass}/${r.score.known}`, color: scoreColor(r),
    }))
  }
}

console.log(`Rendered _site/index.html + ${badges} SVG badges`)

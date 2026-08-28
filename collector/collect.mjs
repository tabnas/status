#!/usr/bin/env node
// Tabnas org status collector.
//
// Sweeps every public repo in the org via the GitHub API and writes
// data/report.json: per-repo compliance against the org "Definition of
// Done" (CI green, shared-CI caller adopted, Renovate, Release Please,
// docs, SHA-pinned actions, branch protection, npm/Go release drift).
//
// Zero dependencies; needs Node >= 20 (global fetch).
//
// Env:
//   GITHUB_TOKEN  read token (Actions' default token is enough for all
//                 public data; branch protection reads may be "unknown"
//                 without a fine-grained org token)
//   ORG           defaults to "tabnas"
//   REPOS         optional space-separated repo names — skips org discovery
//                 (useful for debugging or partial runs)

import { mkdir, writeFile } from 'node:fs/promises'

const ORG = process.env.ORG || 'tabnas'
const TOKEN = process.env.GITHUB_TOKEN || ''
const API = 'https://api.github.com'

// Repos that are infrastructure rather than published packages. `measure`
// (the benchmark harness) and `skills` (the Agent Skills bundle) both declare
// `"private": true` and are published nowhere — scoring them on package rules
// like the shared-CI caller measured a standard they were never under.
const INFRA = new Set(['.github', 'status', 'admin', 'measure', 'skills'])

// Repos omitted from the report entirely (org meta / the dashboard itself —
// they are not packages and not meaningfully "compliant" against the standard).
const EXCLUDE = new Set(['.github', 'status'])

// Tier assignments (mirrors GOVERNANCE.md; authoritative copy will move to
// Safe Settings config once that lands).
const CORE = new Set(['parser', 'abnf', 'debug', 'json', 'railroad'])

// Repos that are NOT grammar plugins, so the plugin-descriptor check does not
// apply to them and is reported as "–" rather than a failure. Mirrors the
// exclusions recorded in admin's tasks/ax-rollout.tsv: the engine is not a
// listed plugin, and tools are not plugins — derivability is not eligibility.
// `web` and `tabnas` (the aggregate checkout) are not packages at all.
// `lsp` is the odd one out: it IS a published package (@tabnas/lsp), so it is
// not infra — but it is a language server over the grammars, not a grammar
// plugin, so no descriptor is owed.
const NOT_PLUGIN = new Set([
  'parser', 'support', 'railroad', 'jsonic-cli', 'mcp', 'skills', 'web', 'tabnas',
  'lsp',
])

// Agent-experience artifacts a repo may point an agent at. Matching any one
// means an agent landing in this repo can find the fleet's agent tooling
// rather than having to already know it exists.
const SKILLS_MARKERS = ['@tabnas/skills', 'tabnas/skills', '@tabnas/mcp']

const SHA_PIN = /^[0-9a-f]{40}$/

async function gh(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    ...opts,
  })
  if (res.status === 404) return { status: 404, body: null }
  if (res.status === 403 || res.status === 401) return { status: res.status, body: null }
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`)
  return { status: res.status, body: await res.json() }
}

async function listRepos() {
  if (process.env.REPOS) {
    const named = await Promise.all(
      process.env.REPOS.split(/\s+/).filter(Boolean).map(async (name) => {
        const { body } = await gh(`/repos/${ORG}/${name}`)
        if (!body) throw new Error(`cannot read repo ${ORG}/${name}`)
        return body
      })
    )
    return named.filter((r) => !r.archived && !EXCLUDE.has(r.name))
  }
  const repos = []
  for (let page = 1; ; page++) {
    const { body } = await gh(`/orgs/${ORG}/repos?per_page=100&page=${page}&type=public`)
    if (!body || body.length === 0) break
    repos.push(...body)
    if (body.length < 100) break
  }
  return repos.filter((r) => !r.archived && !EXCLUDE.has(r.name))
}

async function tree(repo, branch) {
  const { body } = await gh(`/repos/${ORG}/${repo}/git/trees/${branch}?recursive=1`)
  return body ? body.tree.map((t) => t.path) : []
}

async function fileText(repo, path, branch) {
  const { status, body } = await gh(
    `/repos/${ORG}/${repo}/contents/${path}?ref=${branch}`
  )
  if (status !== 200 || !body || !body.content) return null
  return Buffer.from(body.content, 'base64').toString('utf8')
}

// Count open pull requests. The repo object's open_issues_count lumps
// issues and PRs together, so we count PRs directly and subtract. per_page=100
// with a length count is exact for this org (no repo has >100 open PRs);
// if that ever changes the count saturates at 100 rather than lying low.
async function openPullCount(repo) {
  const { body } = await gh(`/repos/${ORG}/${repo}/pulls?state=open&per_page=100`)
  return body ? body.length : 0
}

async function latestRun(repo, branch) {
  const { body } = await gh(
    `/repos/${ORG}/${repo}/actions/runs?branch=${branch}&status=completed&per_page=1`
  )
  const run = body && body.workflow_runs && body.workflow_runs[0]
  return run ? { conclusion: run.conclusion, url: run.html_url, at: run.updated_at } : null
}

async function goTag(repo) {
  const { body } = await gh(`/repos/${ORG}/${repo}/tags?per_page=100`)
  if (!body) return null
  const versions = body
    .map((t) => t.name)
    .filter((n) => /^go\/v\d+\.\d+\.\d+$/.test(n))
    .map((n) => n.slice(4))
    .sort(cmpSemver)
  return versions.at(-1) || null
}

// Returns the latest published version AND when it was published.
//
// The registry's `time` map is keyed by version, so time[latest] is the
// publish instant of the version we are reporting — not `time.modified`,
// which also moves for deprecations and dist-tag changes and would show a
// "last publish" for a release nobody published.
async function npmVersion(name) {
  try {
    const res = await fetch(`https://registry.npmjs.org/@${ORG}%2f${name}`)
    if (!res.ok) return null
    const body = await res.json()
    const version = (body['dist-tags'] && body['dist-tags'].latest) || null
    if (!version) return null
    const published_at = (body.time && body.time[version]) || null
    return { version, published_at }
  } catch {
    return null
  }
}

function cmpSemver(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

async function protection(repo, branch) {
  const { status, body } = await gh(`/repos/${ORG}/${repo}/branches/${branch}/protection`)
  if (status === 200) {
    const reviews = body.required_pull_request_reviews
    return {
      state: 'protected',
      reviews: reviews ? reviews.required_approving_review_count : 0,
      checks: !!body.required_status_checks,
    }
  }
  if (status === 404) return { state: 'unprotected' }
  return { state: 'unknown' } // 401/403: token can't read protection
}

async function inspectWorkflows(repo, branch, paths) {
  const wfPaths = paths.filter(
    (p) => p.startsWith('.github/workflows/') && /\.ya?ml$/.test(p)
  )
  let caller = false
  let unpinned = 0
  let usesTotal = 0
  for (const p of wfPaths.slice(0, 10)) {
    const text = await fileText(repo, p, branch)
    if (!text) continue
    if (text.includes(`${ORG}/.github/.github/workflows/polyglot-ci.yml`)) caller = true
    for (const m of text.matchAll(/^\s*(?:-\s+)?uses:\s*([^\s#]+)/gm)) {
      const ref = m[1]
      if (ref.startsWith('./') || ref.startsWith(`${ORG}/`)) continue // local & org refs
      usesTotal++
      const at = ref.split('@')[1] || ''
      if (!SHA_PIN.test(at)) unpinned++
    }
  }
  return { workflows: wfPaths.length, caller, usesTotal, unpinned }
}

// The agent-experience checks (admin ADR-10/11). Three are path predicates
// like the rest; `error_codes` compares two files that are supposed to agree,
// which is the whole point of declaring codes in the first place.
//
// Each returns null for "does not apply", never false — a repo scoring red
// for a rule that was never meant to cover it is worse than no column.
async function inspectAX(repo, branch, paths, has) {
  const isPlugin = !NOT_PLUGIN.has(repo) && !INFRA.has(repo) && has('ts/package.json')

  const agents_md = has('AGENTS.md')
  const plugin_descriptor = isPlugin ? has('tabnas.plugin.json') : null

  // Only fetch what the predicates above say is worth fetching.
  const agentsText = agents_md ? await fileText(repo, 'AGENTS.md', branch) : null
  const descriptorText =
    plugin_descriptor ? await fileText(repo, 'tabnas.plugin.json', branch) : null

  // Does the repo's own guide document every code its descriptor declares?
  // The descriptor is generated and the guide is written, so this is the one
  // place they can silently disagree — and AGENTS.md's Error codes section
  // exists precisely to be kept in step with it. A plugin that declares no
  // codes has nothing to disagree about, so it passes.
  let error_codes = null
  if (descriptorText && agentsText) {
    try {
      const declared = JSON.parse(descriptorText).errorCodes
      if (Array.isArray(declared)) {
        error_codes = declared.every((code) => agentsText.includes(code))
      }
    } catch {
      error_codes = false // a descriptor that will not parse is a failure
    }
  }

  // Can an agent that lands here find the fleet's Skills and MCP server?
  let skills_linked = null
  if (agentsText || has('README.md')) {
    const readmeText = agentsText ? null : await fileText(repo, 'README.md', branch)
    const text = `${agentsText ?? ''}\n${readmeText ?? ''}`
    skills_linked = SKILLS_MARKERS.some((marker) => text.includes(marker))
  }

  return { agents_md, plugin_descriptor, error_codes, skills_linked }
}

async function inspectRepo(r) {
  const repo = r.name
  const branch = r.default_branch
  const paths = await tree(repo, branch)
  const has = (p) => paths.includes(p)

  const [run, tag, npm, prot, wf, openPRs, ax] = await Promise.all([
    latestRun(repo, branch),
    goTag(repo),
    INFRA.has(repo) ? null : npmVersion(repo),
    protection(repo, branch),
    inspectWorkflows(repo, branch, paths),
    openPullCount(repo),
    inspectAX(repo, branch, paths, has),
  ])

  const open_prs = openPRs
  const open_issues = Math.max(0, (r.open_issues_count ?? 0) - open_prs)

  const checks = {
    readme: has('README.md'),
    license: has('LICENSE') || has('LICENSE.md'),
    ci_green: run ? run.conclusion === 'success' : null, // null = no runs yet
    ci_caller: wf.caller,
    renovate: has('renovate.json') || has('renovate.json5') || has('.github/renovate.json'),
    sha_pinned: wf.usesTotal === 0 ? null : wf.unpinned === 0,
    protected: prot.state === 'unknown' ? null : prot.state === 'protected',
    security_own: has('SECURITY.md') || has('.github/SECURITY.md'),
    contributing_own: has('CONTRIBUTING.md') || has('.github/CONTRIBUTING.md'),
    ...ax,
  }

  // Score over checks that apply to package repos and are knowable.
  //
  // Of the agent-experience checks, only the two that are settled policy for
  // PACKAGE repos are scored: AGENTS.md was rolled out across them (plan
  // B2/B3) and every eligible plugin carries a descriptor (B1), so a red cell
  // there is a real regression. The rest are reported as columns but NOT
  // scored — `error_codes` and `skills_linked` describe work in progress, and
  // AGENTS.md was never stated policy for infra repos, so scoring either would
  // move a number without anything having got worse. A column is still how the
  // gap stays visible.
  //
  // `protected` is TEMPORARILY unscored. Branch protection is not configured
  // on any repo yet: the policy is written but still staged in admin/allstar/
  // and needs a one-time deploy (a public tabnas/.allstar repo plus the app
  // install). Scoring a check that no repo was ever set up to pass held every
  // repo at "not compliant" and hid the checks that had actually moved --
  // the same reasoning that keeps the agent-experience rollout unscored.
  // Restore it to both lists once Allstar is deployed; that is the point at
  // which a red cell here becomes a real regression.
  const scored = INFRA.has(repo)
    ? ['readme', 'license', 'ci_green', 'sha_pinned']
    : ['readme', 'license', 'ci_green', 'ci_caller', 'renovate', 'sha_pinned',
       'agents_md', 'plugin_descriptor']
  let pass = 0
  let known = 0
  for (const k of scored) {
    if (checks[k] === null) continue
    known++
    if (checks[k]) pass++
  }

  return {
    repo,
    description: r.description,
    tier: INFRA.has(repo) ? 'infra' : CORE.has(repo) ? 'core' : 'supported',
    ci: run,
    open_prs,
    open_issues,
    npm_version: npm && npm.version,
    npm_published_at: (npm && npm.published_at) || null,
    go_version: tag,
    version_drift: npm && npm.version && tag ? npm.version !== tag : null,
    protection: prot,
    workflow_count: wf.workflows,
    unpinned_actions: wf.unpinned,
    checks,
    score: { pass, known },
  }
}

const repos = await listRepos()
console.log(`Inspecting ${repos.length} public repos in ${ORG}...`)

const results = []
for (const r of repos) {
  try {
    results.push(await inspectRepo(r))
    console.log(`  ${r.name}: ok`)
  } catch (e) {
    console.error(`  ${r.name}: FAILED — ${e.message}`)
    results.push({ repo: r.name, error: e.message })
  }
}

results.sort((a, b) =>
  (a.tier || 'z').localeCompare(b.tier || 'z') || a.repo.localeCompare(b.repo)
)

const report = {
  org: ORG,
  generated: new Date().toISOString(),
  repos: results,
  summary: {
    total: results.length,
    fully_compliant: results.filter(
      (r) => r.score && r.score.known > 0 && r.score.pass === r.score.known
    ).length,
    open_prs: results.reduce((n, r) => n + (r.open_prs || 0), 0),
    open_issues: results.reduce((n, r) => n + (r.open_issues || 0), 0),
  },
}

await mkdir('data', { recursive: true })
await writeFile('data/report.json', JSON.stringify(report, null, 2))
console.log(
  `Wrote data/report.json — ${report.summary.fully_compliant}/${report.summary.total} fully compliant`
)

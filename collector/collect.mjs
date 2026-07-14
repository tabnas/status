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

// Repos that are infrastructure rather than published packages.
const INFRA = new Set(['.github', 'status', 'admin'])

// Tier assignments (mirrors GOVERNANCE.md; authoritative copy will move to
// Safe Settings config once that lands).
const CORE = new Set(['parser', 'abnf', 'debug', 'json', 'railroad'])

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
    return named.filter((r) => !r.archived)
  }
  const repos = []
  for (let page = 1; ; page++) {
    const { body } = await gh(`/orgs/${ORG}/repos?per_page=100&page=${page}&type=public`)
    if (!body || body.length === 0) break
    repos.push(...body)
    if (body.length < 100) break
  }
  return repos.filter((r) => !r.archived)
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

async function npmVersion(name) {
  try {
    const res = await fetch(`https://registry.npmjs.org/@${ORG}%2f${name}`)
    if (!res.ok) return null
    const body = await res.json()
    return (body['dist-tags'] && body['dist-tags'].latest) || null
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

async function inspectRepo(r) {
  const repo = r.name
  const branch = r.default_branch
  const paths = await tree(repo, branch)
  const has = (p) => paths.includes(p)

  const [run, tag, npm, prot, wf, openPRs] = await Promise.all([
    latestRun(repo, branch),
    goTag(repo),
    INFRA.has(repo) ? null : npmVersion(repo),
    protection(repo, branch),
    inspectWorkflows(repo, branch, paths),
    openPullCount(repo),
  ])

  const open_prs = openPRs
  const open_issues = Math.max(0, (r.open_issues_count ?? 0) - open_prs)

  const checks = {
    readme: has('README.md'),
    license: has('LICENSE') || has('LICENSE.md'),
    ci_green: run ? run.conclusion === 'success' : null, // null = no runs yet
    ci_caller: wf.caller,
    renovate: has('renovate.json') || has('renovate.json5') || has('.github/renovate.json'),
    release_please: has('release-please-config.json'),
    sha_pinned: wf.usesTotal === 0 ? null : wf.unpinned === 0,
    protected: prot.state === 'unknown' ? null : prot.state === 'protected',
    security_own: has('SECURITY.md') || has('.github/SECURITY.md'),
    contributing_own: has('CONTRIBUTING.md') || has('.github/CONTRIBUTING.md'),
  }

  // Score over checks that apply to package repos and are knowable.
  const scored = INFRA.has(repo)
    ? ['readme', 'license', 'ci_green', 'sha_pinned', 'protected']
    : ['readme', 'license', 'ci_green', 'ci_caller', 'renovate', 'release_please', 'sha_pinned', 'protected']
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
    npm_version: npm,
    go_version: tag,
    version_drift: npm && tag ? npm !== tag : null,
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

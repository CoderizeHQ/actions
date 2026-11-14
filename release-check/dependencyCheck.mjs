// The weekly dependency-only release (plan, Phase 3 "Dependency-only releases", D10). It fixes one commit (main's
// head when the run started) and checks every commit since the last version release up to it. Each must be the
// squash merge of a PR that:
// - Renovate's App opened (checked by user ID) from a renovate/** branch, with only Renovate's verified commits;
// - changed only pnpm-lock.yaml (Renovate's update-lockfile strategy);
// - moved every package that changed version within its minor or patch line, from the npm registry only;
// - passed every check on its last commit (ci-site's lockfile checks among them).
// Anything else in the gap leaves the release for James.
//
// The gap starts at the last version tag's release, not the last dependency run. Version tags can only be cut by
// the release App, while anyone with workflow access can create a deployment record, so the last tag is the safe
// starting point; re-checking PRs an earlier dependency run already took costs nothing.

import { gh, ghAll } from '../scripts/lib/github.mjs'
import { RELEASE_BOT_ID } from './releaseCheck.mjs'

export const RENOVATE_ID = 29139614 // renovate[bot]

const OK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral'])
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

/** Same major, and for 0.x the same minor too (what a caret range allows). */
export function isMinorOrPatch(from, to) {
  const a = SEMVER.exec(from)
  const b = SEMVER.exec(to)
  if (!a || !b) return false
  if (a[1] !== b[1]) return false
  return a[1] !== '0' || a[2] === b[2]
}

// A package key in pnpm-lock.yaml v9's packages: or snapshots: section, two spaces in:
//   '@scope/name@1.2.3':   name@1.2.3:   name@1.2.3(peer@4.5.6):
const KEY = /^([+-]) {2}'?((?:@[^/@\s']+\/)?[^@\s'(]+)@([^('\s:]+)(?:\([^']*\))?'?:\s*$/

/**
 * Reads the package versions a pnpm-lock.yaml diff adds and removes.
 * @param {string | undefined} patch the PR file's patch from GitHub
 * @returns {{ problems: string[], bumps: { name: string, from: string[], to: string }[] }}
 */
export function lockfileChanges(patch) {
  if (!patch) return { problems: ['the lockfile diff is too large for GitHub to show, so it cannot be checked'], bumps: [] }
  const problems = []
  const removed = new Map()
  const added = new Map()
  for (const line of patch.split('\n')) {
    if (/^\+\s+resolution: \{(?!integrity:)/.test(line)) problems.push(`a package not from the npm registry: ${line.slice(1).trim()}`)
    const m = KEY.exec(line)
    if (!m) continue
    const [, sign, name, version] = m
    const into = sign === '+' ? added : removed
    if (!into.has(name)) into.set(name, new Set())
    into.get(name).add(version)
  }
  const bumps = []
  for (const [name, versions] of added) {
    const before = removed.get(name)
    for (const to of versions) {
      if (!SEMVER.test(to)) {
        problems.push(`${name}@${to} is not a plain release version`)
        continue
      }
      if (!before || before.has(to)) continue // a new package, or only its peer suffix changed
      const from = [...before]
      if (!from.some((f) => isMinorOrPatch(f, to))) problems.push(`${name} ${from.join(', ')} → ${to} is not a minor or patch update`)
      else bumps.push({ name, from, to })
    }
  }
  return { problems, bumps }
}

/**
 * @typedef {{ number: number, merged: boolean, mergeSha: string, baseRef: string, authorId: number, headRef: string,
 *   files: { name: string, status: string, patch?: string }[], commits: { authorId: number | null, verified: boolean }[],
 *   checks: { name: string, status: string, conclusion: string | null }[], statusState: string, statusCount: number }} Pr
 * @param {{ base: { sha: string, tag: string } | null, head: string, compareStatus: string | null,
 *   commits: { sha: string, pr: Pr | null }[] }} facts
 * @returns {{ ok: boolean, nothing: boolean, reasons: string[], prs: number[] }}
 */
export function decideDependencyRun(facts) {
  const reasons = []
  if (!facts.base) {
    return { ok: false, nothing: false, reasons: ['no earlier release by the release App: the first release must be a version tag'], prs: [] }
  }
  if (facts.compareStatus === 'identical') return { ok: true, nothing: true, reasons: [], prs: [] }
  if (facts.compareStatus !== 'ahead') {
    return { ok: false, nothing: false, reasons: [`main is not ahead of ${facts.base.tag} (GitHub says ${facts.compareStatus})`], prs: [] }
  }

  for (const { sha, pr } of facts.commits) {
    const short = sha.slice(0, 7)
    if (!pr || !pr.merged || pr.mergeSha !== sha) {
      reasons.push(`${short} is not the merge of a pull request`)
      continue
    }
    const n = `#${pr.number}`
    if (pr.baseRef !== 'main') reasons.push(`${n} was not merged into main`)
    if (pr.authorId !== RENOVATE_ID) reasons.push(`${n} was not opened by Renovate`)
    if (!pr.headRef.startsWith('renovate/')) reasons.push(`${n} is not from a renovate/ branch`)
    if (pr.commits.length === 0 || !pr.commits.every((c) => c.authorId === RENOVATE_ID && c.verified)) {
      reasons.push(`${n} has commits that are not Renovate's verified commits`)
    }
    const lockOnly = pr.files.length === 1 && pr.files[0].name === 'pnpm-lock.yaml' && pr.files[0].status === 'modified'
    if (!lockOnly) reasons.push(`${n} changed more than pnpm-lock.yaml`)
    else for (const p of lockfileChanges(pr.files[0].patch).problems) reasons.push(`${n}: ${p}`)
    const failing = pr.checks.filter((c) => c.status !== 'completed' || !OK_CONCLUSIONS.has(c.conclusion))
    if (pr.checks.length === 0) reasons.push(`${n} has no checks`)
    for (const c of failing) reasons.push(`${n}: check ${c.name} is ${c.conclusion ?? c.status}`)
    if (pr.statusCount > 0 && pr.statusState !== 'success') reasons.push(`${n}: commit status is ${pr.statusState}`)
  }
  if (facts.commits.length === 0) reasons.push('main is ahead of the last release but no commits were listed')
  return { ok: reasons.length === 0, nothing: false, reasons, prs: facts.commits.map((c) => c.pr?.number).filter(Boolean) }
}

/**
 * Reads the facts from GitHub's API and decides.
 * @param {string} token @param {string} repo `owner/name` @param {string} head the fixed commit
 */
export async function checkDependencyRun(token, repo, head) {
  const latest = await gh(token, `/repos/${repo}/releases/latest`)
  let base = null
  if (latest && latest.author?.id === RELEASE_BOT_ID) {
    const commit = await gh(token, `/repos/${repo}/commits/${encodeURIComponent(latest.tag_name)}`)
    if (commit) base = { sha: commit.sha, tag: latest.tag_name }
  }
  const facts = { base, head, compareStatus: null, commits: [] }
  if (base) {
    const cmp = await gh(token, `/repos/${repo}/compare/${base.sha}...${head}?per_page=1`)
    facts.compareStatus = cmp?.status ?? 'missing'
    if (facts.compareStatus === 'ahead') {
      const commits = await ghAll(token, `/repos/${repo}/compare/${base.sha}...${head}`, (p) => p?.commits ?? [])
      for (const c of commits) facts.commits.push({ sha: c.sha, pr: await readPr(token, repo, c.sha) })
    }
  }
  return { ...decideDependencyRun(facts), base }
}

async function readPr(token, repo, sha) {
  const pulls = (await gh(token, `/repos/${repo}/commits/${sha}/pulls`)) ?? []
  const p = pulls.find((x) => x.merge_commit_sha === sha)
  if (!p) return null
  const [files, commits, checks, status] = await Promise.all([
    ghAll(token, `/repos/${repo}/pulls/${p.number}/files`),
    ghAll(token, `/repos/${repo}/pulls/${p.number}/commits`),
    ghAll(token, `/repos/${repo}/commits/${p.head.sha}/check-runs`, (page) => page?.check_runs ?? []),
    gh(token, `/repos/${repo}/commits/${p.head.sha}/status`),
  ])
  return {
    number: p.number,
    merged: Boolean(p.merged_at),
    mergeSha: p.merge_commit_sha,
    baseRef: p.base.ref,
    authorId: p.user?.id,
    headRef: p.head.ref,
    files: files.map((f) => ({ name: f.filename, status: f.status, patch: f.patch })),
    commits: commits.map((c) => ({ authorId: c.author?.id ?? null, verified: Boolean(c.commit?.verification?.verified) })),
    checks: checks.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })),
    statusState: status?.state ?? 'pending',
    statusCount: status?.total_count ?? 0,
  }
}

// The weekly dependency-only release (plan, Phase 3 "Dependency-only releases", D10). It fixes one commit (main's
// head when the run started) and checks every commit since the last version release up to it. Each must be the
// squash merge of a PR that:
// - Renovate's App opened (checked by user ID) from a renovate/** branch, with only Renovate's verified commits;
// - changed only pnpm-lock.yaml (Renovate's update-lockfile strategy), and for a pnpm update also package.json's
//   `packageManager` line, to a minor or patch pnpm, with every other key unchanged;
// - moved every package that changed version within its minor or patch line, from the npm registry only;
// - passed every check on its last commit (ci-site's lockfile checks among them).
// The one other commit allowed is platform's own file sync: a commit the platform App wrote straight to main through
// GitHub's API (signed by GitHub as web-flow) that touches only CODEOWNERS or renovate.json, which change neither the
// build nor the release. Only bypass actors on the `sites` ruleset can write to main without a PR, and platform writes
// its files there (platform tofu/sites.tf), so without this one sync would block every later dependency-only release.
// A sync of a workflow (deploy-preview.yml or release.yml) still leaves the next release for James.
// Anything else in the gap leaves the release for James.
//
// The gap starts at the last version tag's release, not the last dependency run. Version tags can only be cut by
// the release App, while anyone with workflow access can create a deployment record, so the last tag is the safe
// starting point; re-checking PRs an earlier dependency run already took costs nothing.

import { isDeepStrictEqual } from 'node:util'

import { gh, ghAll } from '../scripts/lib/github.mjs'
import { RELEASE_BOT_ID } from './releaseCheck.mjs'

export const RENOVATE_ID = 357122915 // coderizehq-renovate[bot]: CoderizeHQ's self-hosted Renovate App (5775623)
export const PLATFORM_ID = 356706027 // coderizehq-platform[bot]: platform's App, which writes the files below
export const WEB_FLOW_ID = 19864447 // web-flow: GitHub's committer, and signer, for commits an App makes through the API

// The files platform writes into every site repo (CoderizeHQ/platform tofu/sites.tf, local.site_files) that change
// neither what is built, nor how it's built or released. Keep this in step with it. The two workflows platform syncs
// are left out on purpose: deploy-preview.yml decides how a commit's stored build is made, and release.yml how it is
// released, so after a sync of either the next release goes live only with James's approval. A file that is part of the
// build or release (NEVER_EXEMPT) is refused even if it is ever added here.
export const PLATFORM_FILES = new Set(['.github/CODEOWNERS', 'renovate.json'])
const NEVER_EXEMPT =
  /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|astro\.config\.[a-z]+|\.github\/workflows\/.*|src\/.*|public\/.*)$/

/**
 * Why a commit that isn't a PR merge is not platform's file sync, or [] when it is one.
 * @param {{ authorId: number | null, committerId: number | null, verified: boolean, parents: number,
 *   files: { name: string, status: string, previous?: string | null }[], filesComplete: boolean } | null | undefined} c
 * @returns {string[]}
 */
export function platformSyncProblems(c) {
  if (!c) return ['its details could not be read']
  const problems = []
  if (c.authorId !== PLATFORM_ID) problems.push('it was not written by the platform App')
  if (c.committerId !== WEB_FLOW_ID || !c.verified) problems.push('it is not a commit GitHub made and signed for an App')
  if (c.parents !== 1) problems.push('it is a merge commit')
  if (!c.filesComplete || c.files.length === 0) problems.push('its files could not all be listed')
  for (const f of c.files) {
    if (NEVER_EXEMPT.test(f.name) || !PLATFORM_FILES.has(f.name)) problems.push(`it changes ${f.name}, which only James may release`)
    // Platform writes files in place; a rename could carry a build input in under a synced file's name.
    if (f.status === 'renamed' || f.previous) problems.push(`it renames ${f.previous ?? 'a file'} to ${f.name}`)
  }
  return problems
}

const PNPM = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha(?:256|512)\.[0-9a-f]+)?$/

/** Whether plain version `to` is later than `from`. */
function isNewer(from, to) {
  const a = from.split('.').map(Number)
  const b = to.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] > a[i]
  return false
}

/**
 * Why a Renovate PR's package.json change is more than a pnpm minor or patch update in `packageManager`, or [].
 * @param {string | null | undefined} before package.json at the squash merge's parent
 * @param {string | null | undefined} after package.json at the squash merge commit
 * @returns {string[]}
 */
export function packageManagerProblems(before, after) {
  let a
  let b
  try {
    a = JSON.parse(before)
    b = JSON.parse(after)
  } catch {
    return ['package.json could not be read before and after']
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return ['package.json could not be read before and after']
  const { packageManager: from, ...restA } = a
  const { packageManager: to, ...restB } = b
  const problems = []
  if (!isDeepStrictEqual(restA, restB)) problems.push('package.json changed more than packageManager')
  const f = PNPM.exec(from ?? '')
  const t = PNPM.exec(to ?? '')
  if (!f || !t) problems.push(`packageManager ${from} → ${to} is not a pnpm release`)
  else if (!isMinorOrPatch(f[1], t[1]) || !isNewer(f[1], t[1])) problems.push(`packageManager ${from} → ${to} is not a minor or patch update`)
  return problems
}

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
 *   checks: { name: string, status: string, conclusion: string | null }[], statusState: string, statusCount: number,
 *   packageJson?: { before: string | null, after: string | null } }} Pr
 * @param {{ base: { sha: string, tag: string } | null, head: string, compareStatus: string | null,
 *   commits: { sha: string, pr: Pr | null, commit?: Parameters<typeof platformSyncProblems>[0] }[] }} facts
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

  for (const { sha, pr, commit } of facts.commits) {
    const short = sha.slice(0, 7)
    if (!pr || !pr.merged || pr.mergeSha !== sha) {
      const sync = platformSyncProblems(commit)
      if (sync.length > 0) reasons.push(`${short} is not the merge of a pull request, nor platform's file sync: ${sync.join('; ')}`)
      continue
    }
    const n = `#${pr.number}`
    if (pr.baseRef !== 'main') reasons.push(`${n} was not merged into main`)
    if (pr.authorId !== RENOVATE_ID) reasons.push(`${n} was not opened by Renovate`)
    if (!pr.headRef.startsWith('renovate/')) reasons.push(`${n} is not from a renovate/ branch`)
    if (pr.commits.length === 0 || !pr.commits.every((c) => c.authorId === RENOVATE_ID && c.verified)) {
      reasons.push(`${n} has commits that are not Renovate's verified commits`)
    }
    // pnpm-lock.yaml, plus package.json only for a pnpm update's `packageManager` line.
    const lock = pr.files.find((f) => f.name === 'pnpm-lock.yaml' && f.status === 'modified')
    const pkg = pr.files.find((f) => f.name === 'package.json' && f.status === 'modified')
    const others = pr.files.filter((f) => f !== lock && f !== pkg)
    if (!lock || others.length > 0) reasons.push(`${n} changed more than pnpm-lock.yaml`)
    else {
      for (const p of lockfileChanges(lock.patch).problems) reasons.push(`${n}: ${p}`)
      if (pkg) for (const p of packageManagerProblems(pr.packageJson?.before, pr.packageJson?.after)) reasons.push(`${n}: ${p}`)
    }
    const failing = pr.checks.filter((c) => c.status !== 'completed' || !OK_CONCLUSIONS.has(c.conclusion))
    if (pr.checks.length === 0) reasons.push(`${n} has no checks`)
    for (const c of failing) reasons.push(`${n}: check ${c.name} is ${c.conclusion ?? c.status}`)
    if (pr.statusCount > 0 && pr.statusState !== 'success') reasons.push(`${n}: commit status is ${pr.statusState}`)
  }
  if (facts.commits.length === 0) reasons.push('main is ahead of the last release but no commits were listed')
  const prs = facts.commits.map((c) => c.pr?.number).filter(Boolean)
  // A gap of platform syncs alone changes nothing that is built, so there is nothing to publish.
  if (reasons.length === 0 && prs.length === 0) return { ok: true, nothing: true, reasons, prs }
  return { ok: reasons.length === 0, nothing: false, reasons, prs }
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
      for (const c of commits) {
        const pr = await readPr(token, repo, c.sha)
        facts.commits.push({ sha: c.sha, pr, commit: pr ? undefined : await readCommit(token, repo, c.sha) })
      }
    }
  }
  return { ...decideDependencyRun(facts), base }
}

/** A commit's author, committer, signature, parents and files, for platformSyncProblems. */
async function readCommit(token, repo, sha) {
  const c = await gh(token, `/repos/${repo}/commits/${sha}`)
  if (!c) return null
  const files = c.files ?? []
  return {
    authorId: c.author?.id ?? null,
    committerId: c.committer?.id ?? null,
    verified: Boolean(c.commit?.verification?.verified),
    parents: c.parents?.length ?? 0,
    files: files.map((f) => ({ name: f.filename, status: f.status, previous: f.previous_filename ?? null })),
    // GitHub lists at most 300 files on one commit and paginates the rest; a sync touches a handful.
    filesComplete: files.length < 300,
  }
}

/** A file's text at a commit, or null. */
async function readText(token, repo, path, ref) {
  const f = await gh(token, `/repos/${repo}/contents/${path}?ref=${ref}`)
  return typeof f?.content === 'string' ? Buffer.from(f.content, 'base64').toString('utf8') : null
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
  // package.json before and after the merge itself: the squash commit's parent and the squash commit. A PR's base.sha
  // can move after it merges, so it is not the state the merge changed.
  let packageJson
  if (files.some((f) => f.filename === 'package.json')) {
    const merge = await gh(token, `/repos/${repo}/commits/${sha}`)
    const parent = merge?.parents?.length === 1 ? merge.parents[0].sha : null
    packageJson = {
      before: parent ? await readText(token, repo, 'package.json', parent) : null,
      after: await readText(token, repo, 'package.json', sha),
    }
  }
  return {
    number: p.number,
    merged: Boolean(p.merged_at),
    packageJson,
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

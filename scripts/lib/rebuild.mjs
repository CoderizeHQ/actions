// Content rebuilds (platform's `rebuild` record field, its README "Content rebuilds"): a live site whose build bakes in
// content from an API (event pages, testimonials, prices) is built again when that content changes, so the change
// reaches live without a code release. Platform's content check (its release-bootstrap.yml, as the release App) hashes
// the record's content URLs every hour and, when the hash changed, sends the site's repo the repository_dispatch
// `content-rebuild`. The site's platform-written rebuild workflow then runs three jobs in one run:
// 1. rebuild-target.yml finds the commit to rebuild (findTarget below): the commit live already runs, never main's
//    head, and only if that commit could go live today by the usual rules (an approved version release, or a
//    dependency-only release on top of one). So a content rebuild never ships code: unreleased merges stay unreleased.
// 2. deploy-preview.yml builds that commit with no credentials and stores it write-once under
//    _builds/<site>/<commit>/rebuilds/<run>/ (lib/build.mjs); the preview is left alone.
// 3. release.yml checks it all again (verify: the same target, found independently) and publishes that stored rebuild
//    to the distribution already serving the site, refusing if live moved to another commit meanwhile.
// GitHub only: no AWS here.
//
// Data refreshes (platform's `refresh` record field, its README "Data refreshes") reuse all of this: platform's refresh
// check sends the repository_dispatch `data-refresh` every few hours (and after a release publishes), and the site's
// platform-written refresh workflow finds the same target here (findTarget with `refresh`), builds it with the
// record's named feed secrets in refresh-build.yml, stores it with deploy-preview.yml and publishes it with release.yml.
// The one difference in the target: a refresh also takes a go-live release (an alias move under way), but only when the
// commit it published is itself an approved release, the same check as any other.

import { checkDependencyRun } from '../../release-check/dependencyCheck.mjs'
import { checkRelease } from '../../release-check/releaseCheck.mjs'
import { CONTENT_SHA256 } from './build.mjs'
import { gh, ghFind } from './github.mjs'

/** The dispatch: its event type, and the only sender taken (the release App, which platform's content check runs as). */
export const CONTENT_REBUILD = { action: 'content-rebuild', senders: ['coderizehq-release[bot]'] }

/** A data refresh's dispatch: the release App again (platform's refresh check), with why it was sent. */
export const DATA_REFRESH = { action: 'data-refresh', senders: ['coderizehq-release[bot]'], reasons: ['first', 'after-release', 'due'] }

const VERSION_TAG = /^v\d+\.\d+\.\d+$/
// The newest 30 deployments are plenty to find the live one: more than 30 failed publishes in a row reads as nothing
// live, and the rebuild is refused rather than guessed.
const DEPLOYMENTS_LOOKED_AT = 30

/** A dispatch's fields come from whoever sent it: only shown, never trusted, and shown tamed. */
export const shown = (v, none) => (v ? String(v).replace(/[^\w./[\]-]/g, '?').slice(0, 60) : none)

/**
 * The dispatch itself: on main, from the release App, naming this site, with a content hash.
 * @returns {string[]} reasons to refuse; none means the dispatch is a content rebuild of this site
 */
export function dispatchProblems({ ref, sender, site, payloadSite, payloadContent }) {
  const reasons = []
  if (ref !== 'refs/heads/main') reasons.push(`a content rebuild runs only on main, not ${shown(ref)}`)
  if (!CONTENT_REBUILD.senders.includes(sender)) {
    reasons.push(`a content rebuild comes only from platform's content check (${CONTENT_REBUILD.senders.join(', ')}), not ${shown(sender, 'an unknown sender')}`)
  }
  if (!site || payloadSite !== site) reasons.push(`this content rebuild names ${shown(payloadSite, 'no site')}, not ${site}`)
  if (!CONTENT_SHA256.test(payloadContent ?? '')) reasons.push(`this content rebuild's content hash ${shown(payloadContent, '(none)')} isn't a SHA-256`)
  return reasons
}

/**
 * A data refresh's dispatch: on main, from the release App, naming this site. Its reason is only shown, and only one of
 * the known ones.
 * @returns {string[]} reasons to refuse
 */
export function refreshDispatchProblems({ ref, sender, site, payloadSite, payloadReason }) {
  const reasons = []
  if (ref !== 'refs/heads/main') reasons.push(`a data refresh runs only on main, not ${shown(ref)}`)
  if (!DATA_REFRESH.senders.includes(sender)) {
    reasons.push(`a data refresh comes only from platform's refresh check (${DATA_REFRESH.senders.join(', ')}), not ${shown(sender, 'an unknown sender')}`)
  }
  if (!site || payloadSite !== site) reasons.push(`this data refresh names ${shown(payloadSite, 'no site')}, not ${site}`)
  if (!DATA_REFRESH.reasons.includes(payloadReason)) reasons.push(`this data refresh's reason ${shown(payloadReason, '(none)')} isn't one of ${DATA_REFRESH.reasons.join(', ')}`)
  return reasons
}

const payloadOf = (d) => {
  if (typeof d.payload !== 'string') return d.payload ?? null
  try {
    return JSON.parse(d.payload)
  } catch {
    return null
  }
}

/**
 * What is live: the newest deployment to `environment` whose newest status is success (GitHub marks the earlier ones
 * inactive), with the kind release recorded in its payload.
 * @returns {Promise<{ id: number, sha: string, kind: string | null } | null>}
 */
export async function liveDeployment(token, repo, environment) {
  const deployments = (await gh(token, `/repos/${repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=${DEPLOYMENTS_LOOKED_AT}`)) ?? []
  for (const d of deployments) {
    const [status] = (await gh(token, `/repos/${repo}/deployments/${d.id}/statuses?per_page=1`)) ?? []
    if (status?.state === 'success') return { id: d.id, sha: d.sha, kind: payloadOf(d)?.kind ?? null }
  }
  return null
}

/** The version tag (vX.Y.Z) on a commit, or null. */
export async function versionTagAt(token, repo, sha) {
  return (await ghFind(token, `/repos/${repo}/tags?per_page=100`, (t) => (VERSION_TAG.test(t.name) && t.commit?.sha === sha ? t.name : undefined))) ?? null
}

/**
 * Whether a commit is one that may go live by the usual rules: a version tag on it still passing release-check, or a
 * clean dependency-only gap on top of the latest version release.
 * @returns {Promise<{ ok: true, sha: string, basis: 'version' | 'dependency', tag: string | null, pr: number | null,
 *   approver: string | null, prs: number[] } | { ok: false, reasons: string[] }>}
 */
export async function approvedCommit({ token, repo, sha, what = 'live', checks = { checkRelease, checkDependencyRun }, read = { versionTagAt } }) {
  const short = sha.slice(0, 7)
  const tag = await read.versionTagAt(token, repo, sha)
  if (tag) {
    const r = await checks.checkRelease(token, repo, `refs/tags/${tag}`)
    if (r.ok && r.sha === sha) return { ok: true, sha, basis: 'version', tag, pr: r.pr ?? null, approver: r.approver ?? null, prs: [] }
    return { ok: false, reasons: [...r.reasons, ...(r.sha === sha ? [] : [`${tag} points at ${r.sha}, not ${what} ${sha}`]), `${what} ${short} (${tag}) no longer passes release-check`] }
  }
  const d = await checks.checkDependencyRun(token, repo, sha)
  if (d.ok && !d.nothing) return { ok: true, sha, basis: 'dependency', tag: d.base?.tag ?? null, pr: null, approver: null, prs: d.prs ?? [] }
  return { ok: false, reasons: [...(d.reasons ?? []), `${what} ${short} is neither an approved version release nor a dependency-only release on top of one`] }
}

/**
 * The commit a content rebuild (or, with `refresh`, a data refresh) builds and publishes: the one live runs now,
 * re-checked by the rules that let it go live (approvedCommit). Anything else is refused: nothing live yet, a commit no
 * release names, or a deployment release didn't write. A go-live release (the first publish, before an alias move) is
 * refused for a content rebuild; a data refresh takes it, but only when its commit passes the same check, so main's
 * head at the go-live is refreshed only if it is a released commit.
 * @returns {Promise<{ ok: true, sha: string, basis: 'version' | 'dependency', tag: string | null, pr: number | null,
 *   approver: string | null, prs: number[] } | { ok: false, reasons: string[] }>}
 */
export async function findTarget({ token, repo, environment, refresh = false, checks = { checkRelease, checkDependencyRun }, read = { liveDeployment, versionTagAt } }) {
  const live = await read.liveDeployment(token, repo, environment)
  const what = refresh ? 'refresh' : 'rebuild'
  if (!live) return { ok: false, reasons: [`nothing is live (no successful deployment to ${environment}), so there is nothing to ${what}`] }
  const short = live.sha.slice(0, 7)
  if (live.kind === 'go-live' && !refresh) {
    return { ok: false, reasons: [`live ${short} is the go-live release (main's head before the alias move); content rebuilds start once a version release is live`] }
  }
  if (!['version', 'dependency', 'content', 'refresh', ...(refresh ? ['go-live'] : [])].includes(live.kind)) {
    return { ok: false, reasons: [`live ${short}'s deployment has kind ${shown(live.kind, '(none)')}, not one release records; look before ${what === 'refresh' ? 'refreshing' : 'rebuilding'} it`] }
  }
  const r = await approvedCommit({ token, repo, sha: live.sha, what: 'live', checks, read })
  if (!r.ok && live.kind === 'go-live') return { ok: false, reasons: [...r.reasons, `live ${short} is the go-live release of main's head, which a data refresh takes only when it is a released commit`] }
  return r
}

/** What a data refresh is, in a line. */
export function describeRefresh({ sha, basis, tag, reason }) {
  const what = basis === 'version' ? tag : `the dependency-only release on ${tag ?? 'the last release'}`
  return `data refresh of ${what} (${String(sha ?? '').slice(0, 7)})${reason ? `, ${reason}` : ''}`
}

/** What a content rebuild is, in a line. */
export function describeTarget({ sha, basis, tag, contentSha256 }) {
  const what = basis === 'version' ? tag : `the dependency-only release on ${tag ?? 'the last release'}`
  return `content rebuild of ${what} (${sha.slice(0, 7)}), content ${String(contentSha256 ?? '').slice(0, 12)}`
}

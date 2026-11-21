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

import { checkDependencyRun } from '../../release-check/dependencyCheck.mjs'
import { checkRelease } from '../../release-check/releaseCheck.mjs'
import { CONTENT_SHA256 } from './build.mjs'
import { gh, ghFind } from './github.mjs'

/** The dispatch: its event type, and the only sender taken (the release App, which platform's content check runs as). */
export const CONTENT_REBUILD = { action: 'content-rebuild', senders: ['coderizehq-release[bot]'] }

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
 * The commit a content rebuild builds and publishes: the one live runs now, re-checked by the rules that let it go
 * live. A version release must still pass release-check; a dependency-only release must still be a clean dependency
 * gap on top of the latest version release. Anything else is refused: nothing live yet, a go-live release (the first
 * publish, before the site's first version release), a commit no release names, or a deployment release didn't write.
 * @returns {Promise<{ ok: true, sha: string, basis: 'version' | 'dependency', tag: string | null, pr: number | null,
 *   approver: string | null, prs: number[] } | { ok: false, reasons: string[] }>}
 */
export async function findTarget({ token, repo, environment, checks = { checkRelease, checkDependencyRun }, read = { liveDeployment, versionTagAt } }) {
  const live = await read.liveDeployment(token, repo, environment)
  if (!live) return { ok: false, reasons: [`nothing is live (no successful deployment to ${environment}), so there is nothing to rebuild`] }
  const short = live.sha.slice(0, 7)
  if (live.kind === 'go-live') {
    return { ok: false, reasons: [`live ${short} is the go-live release (main's head before the alias move); content rebuilds start once a version release is live`] }
  }
  if (!['version', 'dependency', 'content'].includes(live.kind)) {
    return { ok: false, reasons: [`live ${short}'s deployment has kind ${shown(live.kind, '(none)')}, not one release records; look before rebuilding it`] }
  }
  const tag = await read.versionTagAt(token, repo, live.sha)
  if (tag) {
    const r = await checks.checkRelease(token, repo, `refs/tags/${tag}`)
    if (r.ok && r.sha === live.sha) return { ok: true, sha: live.sha, basis: 'version', tag, pr: r.pr ?? null, approver: r.approver ?? null, prs: [] }
    return { ok: false, reasons: [...r.reasons, ...(r.sha === live.sha ? [] : [`${tag} points at ${r.sha}, not live ${live.sha}`]), `live ${short} (${tag}) no longer passes release-check`] }
  }
  const d = await checks.checkDependencyRun(token, repo, live.sha)
  if (d.ok && !d.nothing) return { ok: true, sha: live.sha, basis: 'dependency', tag: d.base?.tag ?? null, pr: null, approver: null, prs: d.prs ?? [] }
  return { ok: false, reasons: [...(d.reasons ?? []), `live ${short} is neither an approved version release nor a dependency-only release on top of one`] }
}

/** What a content rebuild is, in a line. */
export function describeTarget({ sha, basis, tag, contentSha256 }) {
  const what = basis === 'version' ? tag : `the dependency-only release on ${tag ?? 'the last release'}`
  return `content rebuild of ${what} (${sha.slice(0, 7)}), content ${String(contentSha256 ?? '').slice(0, 12)}`
}

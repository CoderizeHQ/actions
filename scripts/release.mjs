// release's two steps (plan, Phase 3 "Shared workflows"; platform's site contract).
//
// `node release.mjs verify` (no AWS, no environment) decides whether this run may publish, through GitHub's API:
// - a version tag (refs/tags/vX.Y.Z): release-check's rules (the release App's merged release-please-- PR, release
//   files only, James's approval at its final commit);
// - main (the weekly dependency run): release-check/dependencyCheck.mjs;
// - main, from the repository_dispatch `go-live-release` that platform's apply sends as the platform App for a site
//   whose new distribution has no aliases yet (GO_LIVE below): its first publish, which publish refuses for a
//   distribution serving any name, so it never lands on the site's domain before James's alias move;
// - main, from the repository_dispatch `content-rebuild` that platform's content check sends as the release App
//   (lib/rebuild.mjs): the commit live runs now, found and re-checked here, built again by the same run's
//   deploy-preview job; publish then takes that run's stored rebuild, only for a distribution already serving the
//   site, and only while live still runs that commit;
// - main, from the repository_dispatch `data-refresh` that platform's refresh check sends as the release App (a data
//   refresh, platform's `refresh` record field): the same target, a go-live release's commit included when it is an
//   approved release, built with the record's feed secrets by the same run's refresh-build job and stored by its
//   deploy-preview job; publish takes that run's stored refresh, also to a distribution with no names yet (an alias
//   move under way), and only while live still runs that commit;
// - anything else is refused.
//
// A site with data refreshes also releases with its feed data (James, C2620 a): its platform-written release workflow
// calls this first with `check-only` (verify alone, whose `refreshable` output says whether this run's commit may be
// built with the secrets: a version or dependency-only release, or a go-live release of a commit that is one), then
// refresh-build.yml and deploy-preview.yml, then this again with `refresh`, which publishes the run's stored refresh of
// its own commit instead of the commit's first build. `refresh-results` carries how the build and store jobs ended, so
// a failed one is refused here, and emailed, rather than skipping silently.
//
// `node release.mjs publish` (the release environment, as coderizehq-live-publish-<site>) then:
// 0. finds the site's live distribution by its Comment, which platform sets to exactly the site name, and the
//    domain from its aliases (the bucket is coderizehq-live-<site> by contract), so the site passes neither. A
//    distribution with no aliases at all is a site moving in by an alias move (platform's `alias_move`): another
//    distribution still serves its domain, so this release publishes to the new one and checks it on its own
//    *.cloudfront.net name, before the names move over;
// 1. reads the stored build's manifest for that exact commit, waiting for deploy-preview to finish storing it;
// 2. downloads every stored file and checks it against the manifest's size and SHA-256;
// 3. copies it into coderizehq-live-<site> server-side from _builds/<site>/<commit>/ (the only writes the live role
//    may make), and deletes what the build doesn't have, refusing a mass delete;
// 4. checks the live bucket again: every file there, by size and ETag (the MD5 of the checked bytes), nothing extra;
// 5. clears the live cache and waits for that, then checks the live home page and robots.txt serve this build and
//    the sitemap answers. A site the live home page answers with `X-Robots-Tag: noindex` is noindex on purpose: that
//    header comes only from platform's `coderizehq-live-noindex` headers policy, which it gives only to a record
//    with `"indexed": false` (a build can't set it). For such a site robots.txt must instead disallow every crawler
//    and name no sitemap (robotsProblems' `noindex`), and no sitemap is fetched;
// 6. records it all as a GitHub deployment to `live`, created once the manifest is read (its payload names the commit,
//    the release PR, the approver and the manifest hash) and marked successful or failed at the end.
//
// A government site (ACCOUNT=government, the workflow's `account` input, which platform writes for a government
// record) is published the same way from its builds in the Government account's locked bucket, as that account's
// coderizehq-live-publish-<site>, into its own locked coderizehq-live-<site>, with one difference: nothing is ever
// deleted from live (lib/build.mjs, "Never delete"). In step 3 a file the build no longer has stays on live, and a page
// it no longer has stops the release before anything is written, unless the site's redirect map (platform's redirect
// sync writes the record's `redirects` into the government redirect store, which this reads) sends the page's URL
// elsewhere. Step 4 then allows exactly those kept objects beside the build. Copies there ask S3 for a SHA-256
// checksum, as a locked bucket's uploads need one.

import {
  ACCOUNTS,
  buildsBucket,
  checkAccount,
  checkRun,
  checkSha,
  checkSite,
  DEFAULT_MAX_DELETE_SHARE,
  GOVERNMENT_REDIRECT_STORE,
  isPage,
  refreshRef,
  deleteGuard,
  liveBucket,
  manifestKey,
  neverDeletePlan,
  pageUrl,
  planSync,
  pool,
  readManifest,
  storedKey,
} from './lib/build.mjs'
import { hashes, plainEtag } from './lib/files.mjs'
import { notClosedToEveryCrawler } from './lib/robots.mjs'
import { gh } from './lib/github.mjs'
import { checkClaims, requestClaims } from './lib/oidc.mjs'
import {
  approvedCommit,
  CONTENT_REBUILD,
  DATA_REFRESH,
  describeRefresh,
  describeTarget,
  dispatchProblems,
  findTarget,
  liveDeployment,
  refreshDispatchProblems,
} from './lib/rebuild.mjs'
import { output, runIfMain, summary } from './lib/report.mjs'
import { checkDependencyRun } from '../release-check/dependencyCheck.mjs'
import { checkRelease } from '../release-check/releaseCheck.mjs'

const PARALLEL = 8
const VERSION_TAG = /^refs\/tags\/v\d+\.\d+\.\d+$/
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A site's go-live release (platform docs/go-live.md, "Zero-downtime cutover"): platform's apply sends the site's repo
 * this repository_dispatch, as the platform App, for a site going live by an alias move whose new distribution has no
 * aliases yet. It publishes main's head, so the site's first publish needs no release PR and no Release-As commit. It
 * never lands on the site's domain: publish refuses a distribution that serves any name, before and again right after
 * waiting for the stored build, so only the new distribution's own *.cloudfront.net name (public, but linked from
 * nowhere) serves it until James runs platform's alias-move.yml, which checks the site first. After the move, the
 * site's releases are version releases as usual.
 */
export const GO_LIVE = { action: 'go-live-release', senders: ['coderizehq-platform[bot]'] }

/** How a release run's refresh build and store jobs must end for it to publish their refresh (refresh-results). */
export const REFRESH_RESULTS_OK = 'build=success,store=success'

/**
 * The decision, then, for a site with data refreshes, what may be built with its feed secrets and what publish takes.
 * `refresh`: the caller asks to publish this run's stored refresh (always so for a data-refresh dispatch);
 * `refreshResults`: how its build and store jobs ended; `checkOnly`: the first, verify-only call of a refresh site's
 * release, which wants `refreshable`. A data refresh, or a release asked to publish a refresh, is refused unless the
 * commit may be refreshed at all (`refreshable`) and both jobs succeeded.
 * @returns {Promise<{ publish: boolean, kind?: string, refreshable?: boolean, refresh?: boolean, pr?: number | null,
 *   approver?: string | null, prs?: number[], reasons: string[] }>}
 */
export async function verify(args) {
  const r = await decide({ ...args, wantRefreshable: args.refresh === true || args.checkOnly === true })
  if (!r.publish) return r
  const refresh = r.kind === 'refresh' || args.refresh === true
  if (!refresh) return r
  const reasons = []
  if (r.kind === 'refresh' && args.refresh !== true) reasons.push("a data refresh publishes its own refresh build: its workflow must call release with refresh: true")
  if (!r.refreshable) reasons.push(`${r.kind} release of ${String(r.commit ?? args.sha).slice(0, 7)} isn't an approved released commit, so it can't be built with the site's feed secrets`)
  if (args.refreshResults !== REFRESH_RESULTS_OK) {
    reasons.push(`the refresh's build and store didn't both succeed (${String(args.refreshResults ?? '').replace(/[^\w=,-]/g, '?').slice(0, 80) || 'no results'}), so there's no refresh build to publish`)
  }
  if (reasons.length) return { publish: false, reasons }
  return { ...r, refresh: true }
}

async function decide({
  token,
  repo,
  ref,
  sha,
  event,
  dispatch,
  sender,
  site,
  payloadSite,
  payloadContent,
  payloadReason,
  environment = 'live',
  wantRefreshable = false,
  checks = { checkRelease, checkDependencyRun, findTarget, approvedCommit },
}) {
  // A data refresh: the live commit, found again here as for a content rebuild, but a go-live release's included when it
  // is an approved release (findTarget's refresh).
  if (event === 'repository_dispatch' && dispatch === DATA_REFRESH.action) {
    const reasons = refreshDispatchProblems({ ref, sender, site, payloadSite, payloadReason })
    if (reasons.length) return { publish: false, reasons }
    const t = await (checks.findTarget ?? findTarget)({ token, repo, environment: deploymentEnvironment(site, environment), refresh: true })
    if (!t.ok) return { publish: false, reasons: t.reasons }
    return {
      publish: true,
      kind: 'refresh',
      refreshable: true,
      commit: t.sha,
      pr: t.pr,
      approver: t.approver,
      prs: t.prs,
      rebuild: { basis: t.basis, tag: t.tag, reason: payloadReason },
      reasons: [],
    }
  }
  // A content rebuild: the commit live runs now, found again here, never trusting the build job's word for it.
  if (event === 'repository_dispatch' && dispatch === CONTENT_REBUILD.action) {
    const reasons = dispatchProblems({ ref, sender, site, payloadSite, payloadContent })
    if (reasons.length) return { publish: false, reasons }
    const t = await (checks.findTarget ?? findTarget)({ token, repo, environment: deploymentEnvironment(site, environment) })
    if (!t.ok) return { publish: false, reasons: t.reasons }
    return {
      publish: true,
      kind: 'content',
      commit: t.sha,
      pr: t.pr,
      approver: t.approver,
      prs: t.prs,
      rebuild: { basis: t.basis, tag: t.tag, contentSha256: payloadContent },
      reasons: [],
    }
  }
  if (event === 'repository_dispatch' && dispatch === GO_LIVE.action) {
    // The sender and the payload come from whoever sent the dispatch: only shown, never trusted, and shown tamed.
    const shown = (v, none) => (v ? String(v).replace(/[^\w./[\]-]/g, '?').slice(0, 60) : none)
    const reasons = []
    if (ref !== 'refs/heads/main') reasons.push(`a go-live release runs only on main, not ${shown(ref)}`)
    if (!GO_LIVE.senders.includes(sender)) reasons.push(`a go-live release comes only from platform's apply (${GO_LIVE.senders.join(', ')}), not ${shown(sender, 'an unknown sender')}`)
    if (!site || payloadSite !== site) reasons.push(`this go-live release names ${shown(payloadSite, 'no site')}, not ${site}`)
    if (reasons.length) return { publish: false, reasons }
    // main's head, with no release PR: it may be built with feed secrets only if it is itself an approved release
    // (asked only by a refresh site's release, so no other site's go-live reads more than before).
    if (!wantRefreshable) return { publish: true, kind: 'go-live', pr: null, approver: null, reasons: [] }
    const approved = await (checks.approvedCommit ?? approvedCommit)({ token, repo, sha, what: "main's head", checks })
    return { publish: true, kind: 'go-live', refreshable: approved.ok, pr: null, approver: null, reasons: [] }
  }
  if (VERSION_TAG.test(ref)) {
    const r = await checks.checkRelease(token, repo, ref)
    const reasons = [...r.reasons]
    if (r.sha !== sha) reasons.push(`the tag points at ${r.sha}, but this run is for ${sha}`)
    if (reasons.length) return { publish: false, reasons }
    return { publish: true, kind: 'version', refreshable: true, pr: r.pr, approver: r.approver, reasons: [] }
  }
  if (ref === 'refs/heads/main') {
    const r = await checks.checkDependencyRun(token, repo, sha)
    if (r.nothing) return { publish: false, reasons: [], nothing: true }
    if (!r.ok) return { publish: false, reasons: [...r.reasons, 'dependency-only release left for James'] }
    return { publish: true, kind: 'dependency', refreshable: true, pr: null, approver: null, prs: r.prs, reasons: [] }
  }
  return { publish: false, reasons: [`release runs only for a version tag (vX.Y.Z) or main, not ${ref}`] }
}

/** Reads the stored manifest, waiting for deploy-preview to store the commit's build. */
export async function waitForManifest({ store, site, commit, rebuild = null, account = 'live', waitMs = 20 * 60_000, pollMs = 30_000, log = console.log }) {
  const key = manifestKey(site, commit, rebuild)
  const bucket = buildsBucket(account)
  const until = Date.now() + waitMs
  for (;;) {
    const got = await store.get(bucket, key)
    if (got) return got
    if (Date.now() >= until) throw new Error(`no stored build for ${commit} (${key}); has deploy-preview run for it?`)
    log(`waiting for deploy-preview to store ${commit}…`)
    await sleep(pollMs)
  }
}

/**
 * A never-delete release's refusal: the pages live has that the build doesn't, with no redirect.
 * @returns {string}
 */
export function neverDeleteRefusal(site, refused) {
  const shown = refused.slice(0, 20).map((k) => `${pageUrl(k)} (${k})`)
  const more = refused.length > shown.length ? `\n…and ${refused.length - shown.length} more` : ''
  return (
    `${site} is a government site, whose releases never delete a page, but this build lacks ${refused.length} ` +
    `page${refused.length === 1 ? '' : 's'} live now with no redirect in its record:\n${shown.join('\n')}${more}\n` +
    "Nothing was published. Put the page back in the build, or add a redirect for its URL to the record's redirects " +
    '(platform sites/<site>.json) and apply it, then release again.'
  )
}

/**
 * Steps 1 to 5 above. `account` is the site's (lib/build.mjs ACCOUNTS): where its builds are read from, and whether
 * live never deletes (a government site: `kept` lists what stayed on live that the build doesn't have).
 * @returns {Promise<{ manifestSha256: string, files: { path: string, size: number, sha256: string, etag: string }[],
 *   copies: number, deletes: number, unchanged: number, invalidation: string, kept?: string[], redirected?: string[] }>}
 */
export async function publishLive({ store, site, repo, commit, rebuild = null, account = 'live', distributionId, stored, maxShare = DEFAULT_MAX_DELETE_SHARE, waitMs, pollMs, log = console.log }) {
  const { builds, neverDelete } = ACCOUNTS[checkAccount(account)]
  stored ??= await waitForManifest({ store, site, commit, rebuild, account, waitMs, pollMs, log })
  const manifestSha256 = hashes(stored.body).sha256
  const manifest = readManifest(JSON.parse(stored.body.toString('utf8')), { site, repo, commit, rebuild })

  // The bytes themselves, not S3's word for them: this is what goes live.
  const files = await pool(manifest, PARALLEL, async (f) => {
    const obj = await store.get(builds, storedKey(site, commit, f.path, rebuild))
    if (!obj) throw new Error(`stored build is missing ${f.path}`)
    const h = hashes(obj.body)
    if (h.size !== f.size || h.sha256 !== f.sha256) throw new Error(`stored ${f.path} doesn't match the manifest`)
    if (plainEtag(obj.etag) !== h.md5) throw new Error(`stored ${f.path} has an ETag that isn't its MD5, so live can't be checked by ETag`)
    return { ...f, etag: h.md5 }
  })
  log(`stored build checked: ${files.length} files match manifest ${manifestSha256}`)

  const bucket = liveBucket(site)
  const current = (await store.list(bucket, '')).map((c) => ({ key: c.key, etag: plainEtag(c.etag) }))
  const plan = planSync(files, current)

  // Never delete: what the build no longer has stays on live, and a dropped page needs a redirect, read from the
  // account's redirect store only when a page is dropped. Refused before anything is written.
  let kept = null
  if (neverDelete) {
    const dropped = plan.deletes
    const redirects = dropped.some(isPage) ? await store.redirects(GOVERNMENT_REDIRECT_STORE, site) : null
    const never = neverDeletePlan(dropped, redirects)
    if (never.refused.length) throw new Error(neverDeleteRefusal(site, never.refused))
    kept = never
    plan.deletes = []
    if (dropped.length) {
      log(`never delete: ${dropped.length} on live but not in the build stay (${never.redirected.length} redirected pages, ${dropped.length - never.redirected.length} files)`)
    }
  } else {
    const refusal = deleteGuard({ current: current.length, deletes: plan.deletes.length, maxShare })
    if (refusal) throw new Error(refusal)
  }

  // A locked bucket's writes carry a checksum: copies into one ask S3 for the copy's SHA-256.
  const copyOptions = neverDelete ? [{ checksum: 'SHA256' }] : []
  await pool(plan.copies, PARALLEL, (file) => store.copy(builds, storedKey(site, commit, file, rebuild), bucket, file, ...copyOptions))
  if (plan.deletes.length) await store.deleteMany(bucket, plan.deletes)
  log(`live: ${plan.copies.length} copied, ${plan.deletes.length} deleted, ${plan.unchanged} unchanged`)

  const after = new Map((await store.list(bucket, '')).map((c) => [c.key, c]))
  const problems = []
  for (const f of files) {
    const o = after.get(f.path)
    if (!o) problems.push(`${f.path} is missing on live`)
    else if (o.size !== f.size || plainEtag(o.etag) !== f.etag) problems.push(`${f.path} on live doesn't match the build`)
    after.delete(f.path)
  }
  for (const key of kept?.kept ?? []) {
    if (!after.has(key)) problems.push(`${key} was kept, but is gone from live`)
    after.delete(key)
  }
  for (const key of after.keys()) problems.push(`${key} is on live but not in the build`)
  if (problems.length) throw new Error(`live doesn't match the build:\n${problems.slice(0, 20).join('\n')}`)
  log(kept ? `live bucket checked: the build, and the ${kept.kept.length} kept objects` : 'live bucket checked: exactly the build')

  const invalidation = await store.invalidate(distributionId, ['/*'], `${site}-${commit}-${Date.now()}`)
  await store.waitInvalidation(distributionId, invalidation)
  log(`live cache cleared (${invalidation})`)
  return {
    manifestSha256,
    files,
    copies: plan.copies.length,
    deletes: plan.deletes.length,
    unchanged: plan.unchanged,
    invalidation,
    ...(kept ? { kept: kept.kept, redirected: kept.redirected } : {}),
  }
}

/**
 * The site's live distribution and domain: the one distribution whose Comment is the site name, and its alias that is
 * the site's domain (the apex; the other is www). `host` is the name the live checks ask: the domain, or, for a
 * distribution with no aliases yet (a site moving in by an alias move, platform's `alias_move`), its own
 * *.cloudfront.net name, with `domain` null: the domain still reaches the distribution the site is moving from.
 * @returns {Promise<{ distributionId: string, domain: string | null, host: string }>}
 */
export async function findLive(store, site) {
  const d = await store.findDistribution(site)
  if (!d) throw new Error(`no CloudFront distribution has the comment ${site}; is the site's live hosting applied?`)
  const domain = d.aliases.find((a) => !a.startsWith('www.') && a.replaceAll('.', '-') === site)
  if (domain) return { distributionId: d.id, domain, host: domain }
  if (!d.aliases.length && d.domainName) return { distributionId: d.id, domain: null, host: d.domainName }
  throw new Error(`distribution ${d.id} has no alias matching ${site} (${d.aliases.join(', ')})`)
}

/**
 * Whether a sitemap's host is the site's: its domain or www, or, with the domain unknown (before an alias move), the
 * name or its www whose dots as hyphens are the site name.
 */
export function isSiteHost(host, { domain, site }) {
  if (domain) return host === domain || host === `www.${domain}`
  return host.replace(/^www\./, '').replaceAll('.', '-') === site
}

/**
 * Problems with a robots.txt that would hide the site (the preview-robots-ships-to-live lesson), or, with `noindex`
 * (a site platform serves with `X-Robots-Tag: noindex`, step 5), one that would let crawlers in or names a sitemap.
 * @param {string} text
 * @param {{ noindex?: boolean }} [opts]
 */
export function robotsProblems(text, { noindex = false } = {}) {
  const problems = []
  let agents = []
  let inRules = false
  const blocked = new Set()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const field = m[1].toLowerCase()
    const value = m[2].trim()
    if (field === 'user-agent') {
      if (inRules) agents = []
      inRules = false
      agents.push(value)
    } else if (field === 'disallow' || field === 'allow') {
      inRules = true
      if (field === 'disallow' && value === '/' && agents.includes('*')) blocked.add('*')
    }
  }
  if (noindex) {
    for (const p of notClosedToEveryCrawler(text)) problems.push(`${p}: it must disallow every crawler from the whole site, since the site is served noindex (its record says indexed: false)`)
    if (sitemapsIn(text).length) problems.push('robots.txt names a Sitemap, but the site is served noindex (its record says indexed: false)')
    return problems
  }
  if (blocked.has('*')) problems.push('robots.txt disallows every crawler from the whole site')
  if (!sitemapsIn(text).length) problems.push('robots.txt names no Sitemap')
  return problems
}

const sitemapsIn = (text) => [...text.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1])

/**
 * Step 5's checks against the live site: the home page and robots.txt are this build's bytes (waiting out the cache
 * clear), and every sitemap robots.txt names answers on this site. `host` is where the requests go: the domain, or the
 * distribution's own *.cloudfront.net name before an alias move (`domain` null, see findLive), where a sitemap on the
 * site's domain is fetched by its path.
 * @returns {Promise<string[]>} problems
 */
export async function checkLiveSite({ domain, site, host = domain, files, fetchImpl = fetch, waitMs = 10 * 60_000, pollMs = 15_000, log = console.log }) {
  const byPath = new Map(files.map((f) => [f.path, f]))
  const get = async (url) => {
    const res = await fetchImpl(url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } })
    return { status: res.status, url: res.url || url, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) }
  }
  const matches = (r, file) => r.status === 200 && (!byPath.has(file) || hashes(r.body).sha256 === byPath.get(file).sha256)

  const problems = []
  const until = Date.now() + waitMs
  let home
  let robots
  for (;;) {
    home = await get(`https://${host}/`)
    robots = await get(`https://${host}/robots.txt`)
    if (matches(home, 'index.html') && matches(robots, 'robots.txt')) break
    if (Date.now() >= until) break
    log('waiting for the live cache to serve the new build…')
    await sleep(pollMs)
  }
  if (!byPath.has('index.html')) problems.push('the build has no index.html')
  if (!matches(home, 'index.html')) problems.push(`the home page (${home.status}) isn't this build's index.html`)
  if (!matches(robots, 'robots.txt')) problems.push(`robots.txt (${robots.status}) isn't this build's robots.txt`)
  if (robots.status !== 200) return problems

  const text = robots.body.toString('utf8')
  // Platform's live noindex headers policy, given only to a record with "indexed": false (step 5 above).
  const noindex = /(^|[\s,])(noindex|none)($|[\s,])/i.test(home.headers?.get?.('x-robots-tag') ?? '')
  problems.push(...robotsProblems(text, { noindex }))
  if (noindex) return problems
  for (const url of sitemapsIn(text)) {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      problems.push(`robots.txt names a sitemap that isn't a URL: ${url}`)
      continue
    }
    if (!isSiteHost(parsed.hostname, { domain, site })) {
      problems.push(`robots.txt names a sitemap on another host: ${url}`)
      continue
    }
    const r = await get(domain ? url : `https://${host}${parsed.pathname}${parsed.search}`)
    const body = r.body.toString('utf8')
    if (r.status !== 200 || !/<(urlset|sitemapindex)[\s>]/.test(body)) problems.push(`sitemap ${url} answered ${r.status} without a sitemap in it`)
  }
  return problems
}

/**
 * The GitHub deployment environment a release is recorded under: `live`, or `live-<site>` for a site that shares its
 * repo with other sites (platform README "Sites in an app repo"), which only that site's own name can be.
 */
export function deploymentEnvironment(site, value = 'live') {
  const env = value || 'live'
  if (env !== 'live' && env !== `live-${site}`) throw new Error(`deployment must be live or live-${site} (got ${env})`)
  return env
}

/**
 * The deployment record's payload: what was published, why it was allowed, and from which build. A content rebuild
 * also names its run (the stored rebuild's folder, _builds/<site>/<commit>/rebuilds/<run>/, which platform's fleet
 * report checks live against), what it rebuilt and the content hash platform sent. A data refresh, or a release
 * published with its feed data, names its refresh instead (_builds/<site>/<commit>/refreshes/<run>/).
 */
export function deploymentPayload({ kind, commit, pr, approver, prs, manifestSha256, workflowSha, domain, runUrl, rebuild = null, refresh = null, account = 'live' }) {
  return {
    kind,
    commit,
    release_pr: pr ?? null,
    approver: approver ?? null,
    dependency_prs: prs ?? [],
    manifest_sha256: manifestSha256 ?? null,
    workflow_sha: workflowSha,
    site_url: `https://${domain}`,
    run: runUrl,
    ...(rebuild ? { rebuild: { run: rebuild.run, basis: rebuild.basis ?? null, tag: rebuild.tag ?? null, content_sha256: rebuild.contentSha256 ?? null } } : {}),
    ...(refresh ? { refresh: { run: refresh.run, basis: refresh.basis ?? null, tag: refresh.tag ?? null, reason: refresh.reason ?? null } } : {}),
    // Only a government site's record names its account, so a live site's is what it always was.
    ...(account !== 'live' ? { account } : {}),
  }
}

/** A never-delete release's summary: what stayed on live that the build no longer has. */
export function keptSummary({ kept, redirected }) {
  if (!kept.length) return '\n\nNever delete: nothing on live is missing from the build.'
  const files = kept.length - redirected.length
  return (
    `\n\nNever delete: ${kept.length} on live but not in the build stayed there (nothing was deleted): ` +
    `${redirected.length} redirected page${redirected.length === 1 ? '' : 's'}, ${files} file${files === 1 ? '' : 's'}.`
  )
}

/** The release kinds publish accepts. */
export const KINDS = ['version', 'dependency', 'go-live', 'content', 'refresh']

/** What allowed a release, in a line. */
export function describe({ kind, pr, approver, prs, commit, rebuild, refresh }) {
  const withData = refresh && kind !== 'refresh' ? `, built with its feed data (refresh ${refresh.run})` : ''
  if (kind === 'version') return `release PR #${pr}, approved by ${approver}${withData}`
  if (kind === 'go-live') return `go-live release of main's head, before the alias move${withData}`
  if (kind === 'dependency') return `dependency-only: Renovate PRs ${(prs ?? []).map((n) => `#${n}`).join(', ')}${withData}`
  if (kind === 'content') return describeTarget({ sha: commit ?? '', basis: rebuild?.basis, tag: rebuild?.tag, contentSha256: rebuild?.contentSha256 })
  if (kind === 'refresh') return describeRefresh({ sha: commit ?? '', basis: refresh?.basis ?? rebuild?.basis, tag: refresh?.tag ?? rebuild?.tag, reason: refresh?.reason ?? rebuild?.reason })
  throw new Error(`unknown release kind ${kind}`)
}

/**
 * A content rebuild republishes a site that is live on its domain. A distribution with no aliases yet (an alias move
 * under way) is refused, and so is a site whose live commit moved since the rebuild found its target (a release
 * published meanwhile), which would otherwise go back to older code.
 * @returns {string | null} the refusal
 */
export function contentRefusal(kind, { distributionId, domain, site, commit, liveSha }) {
  if (kind !== 'content') return null
  if (!domain) return `a content rebuild republishes a live site, but ${distributionId} serves no name yet (an alias move under way): ${site} gets content rebuilds once its names have moved`
  if (liveSha !== commit) {
    return `live moved from ${commit.slice(0, 7)} to ${liveSha ? liveSha.slice(0, 7) : 'nothing'} since this content rebuild found its target, so it isn't published (platform's next check rebuilds the new commit if the content still differs)`
  }
  return null
}

/**
 * A data refresh republishes the commit live runs now, also to a distribution with no names yet (an alias move under
 * way: the feed data goes in before the names move). It is refused if live moved to another commit since it found its
 * target, which would otherwise put older code back.
 * @returns {string | null} the refusal
 */
export function refreshRefusal(kind, { commit, liveSha }) {
  if (kind !== 'refresh' || liveSha === commit) return null
  return `live moved from ${commit.slice(0, 7)} to ${liveSha ? liveSha.slice(0, 7) : 'nothing'} since this data refresh found its target, so it isn't published (platform's refresh check refreshes the new commit next)`
}

/**
 * A go-live release publishes only to a distribution that serves no name yet (findLive's domain null): until James
 * runs platform's alias-move.yml, nobody but its own *.cloudfront.net name reaches it. Anything else is refused.
 * @returns {string | null} the refusal
 */
export function goLiveRefusal(kind, { distributionId, domain, site }) {
  if (kind !== 'go-live' || !domain) return null
  return `a go-live release publishes only to a distribution with no aliases yet (before its alias move), but ${distributionId} serves ${domain}: release ${site} with a release PR instead`
}

async function verifyMain() {
  const {
    GH_TOKEN: token,
    REPO: repo,
    REF: ref,
    SHA: sha,
    EVENT: event,
    DISPATCH: dispatch,
    SENDER: sender,
    SITE: site,
    PAYLOAD_SITE: payloadSite,
    PAYLOAD_CONTENT: payloadContent,
    PAYLOAD_REASON: payloadReason,
    DEPLOYMENT: environment,
    REFRESH: refreshInput,
    REFRESH_RESULTS: refreshResults,
    CHECK_ONLY: checkOnly,
  } = process.env
  if (!token || !repo || !ref) throw new Error('GH_TOKEN, REPO and REF must be set')
  const result = await verify({
    token,
    repo,
    ref,
    sha: checkSha(sha),
    event,
    dispatch,
    sender,
    site,
    payloadSite,
    payloadContent,
    payloadReason,
    environment,
    refresh: refreshInput === 'true',
    refreshResults,
    checkOnly: checkOnly === 'true',
  })
  output('publish', String(result.publish))
  output('refreshable', String(result.publish === true && result.refreshable === true))
  if (result.nothing) {
    console.log('::notice::no dependency update since the last release; nothing to publish')
    summary('No dependency update since the last release (only platform syncs, if anything); nothing published.')
    return
  }
  if (!result.publish) {
    for (const r of result.reasons) console.log(`::error::${r}`)
    // For the email (notify.mjs): one line, since a step output is one line.
    output('reasons', result.reasons.join('; ').replace(/\s+/g, ' '))
    summary(`### Release refused\n\n${result.reasons.map((r) => `- ${r}`).join('\n')}`)
    process.exit(1)
  }
  // What publish publishes: the run's own commit, or, for a content rebuild, the live commit verify found.
  const commit = checkSha(result.commit ?? sha)
  output('kind', result.kind)
  output('commit', commit)
  output('release-pr', result.pr ?? '')
  output('approver', result.approver ?? '')
  output('dependency-prs', (result.prs ?? []).join(','))
  output('rebuild-basis', result.rebuild?.basis ?? '')
  output('rebuild-tag', result.rebuild?.tag ?? '')
  output('content-sha256', result.rebuild?.contentSha256 ?? '')
  output('refresh', String(result.refresh === true))
  output('refresh-reason', DATA_REFRESH.reasons.includes(result.rebuild?.reason) ? result.rebuild.reason : '')
  const why = describe({ ...result, commit, refresh: result.refresh ? { run: 'this run', basis: result.rebuild?.basis, tag: result.rebuild?.tag, reason: result.rebuild?.reason } : null })
  console.log(`release of ${commit} accepted (${why})`)
  summary(`### Release accepted\n\n\`${commit}\`: ${why}.`)
}

async function publishMain() {
  const env = process.env
  const site = checkSite(env.SITE)
  const environment = deploymentEnvironment(site, env.DEPLOYMENT)
  const commit = checkSha(env.COMMIT)
  // The run's own commit, which the OIDC token names. Only a content rebuild or a data refresh publishes another commit
  // (the live one, verify's output); every other kind publishes exactly the run's.
  const runSha = checkSha(env.RUN_SHA || env.COMMIT, 'run')
  const workflowSha = checkSha(env.WORKFLOW_SHA, 'workflow')
  const { REPO: repo, GH_TOKEN: token } = env
  if (!KINDS.includes(env.KIND)) throw new Error(`unknown release kind ${env.KIND}`)
  if (!['content', 'refresh'].includes(env.KIND) && commit !== runSha) throw new Error(`a ${env.KIND} release publishes the run's own commit ${runSha}, not ${commit}`)
  const rebuild =
    env.KIND === 'content'
      ? { run: checkRun(env.REBUILD_RUN), basis: env.REBUILD_BASIS || null, tag: env.REBUILD_TAG || null, contentSha256: env.CONTENT_SHA256 || null }
      : null
  // A data refresh, or a release published with its feed data: this run's stored refresh (refreshes/<run>/).
  if (env.KIND === 'refresh' && !env.REFRESH_RUN) throw new Error('a data refresh publishes its own refresh build, but REFRESH_RUN is empty')
  const refresh = env.REFRESH_RUN
    ? { run: checkRun(env.REFRESH_RUN), basis: env.REBUILD_BASIS || null, tag: env.REBUILD_TAG || null, reason: DATA_REFRESH.reasons.includes(env.REFRESH_REASON) ? env.REFRESH_REASON : null }
    : null
  const storedRef = refresh ? refreshRef(refresh.run) : (rebuild?.run ?? null)
  const maxShare = env.MAX_DELETE_SHARE ? Number(env.MAX_DELETE_SHARE) : DEFAULT_MAX_DELETE_SHARE
  // Before any AWS call: live or government, nothing else. The credentials are already that account's publish role.
  const account = checkAccount(env.ACCOUNT)

  const problems = checkClaims(await requestClaims(), { workflow: 'release.yml', workflowSha, repo, commit: runSha })
  if (problems.length) throw new Error(`the OIDC token doesn't match this run: ${problems.join('; ')}`)

  const { awsStore } = await import('./lib/aws.mjs')
  const store = awsStore()
  const { distributionId, domain, host } = await findLive(store, site)
  const refusal = goLiveRefusal(env.KIND, { distributionId, domain, site })
  if (refusal) throw new Error(refusal)
  // A content rebuild: only where the site is live on its domain, and only while live still runs its commit. Asked
  // again right before anything is written, below, since this job may have queued behind another release.
  const liveNow = async () => ((await liveDeployment(token, repo, environment))?.sha ?? null)
  if (rebuild) {
    const early = contentRefusal(env.KIND, { distributionId, domain, site, commit, liveSha: await liveNow() })
    if (early) throw new Error(early)
  }
  if (env.KIND === 'refresh') {
    const early = refreshRefusal(env.KIND, { commit, liveSha: await liveNow() })
    if (early) throw new Error(early)
  }
  if (!domain) console.log(`::notice::${site}: the distribution has no aliases yet (an alias move); publishing to it and checking it at https://${host}`)
  output('site-url', `https://${host}`)

  const base = {
    kind: env.KIND,
    commit,
    rebuild,
    refresh,
    pr: env.RELEASE_PR ? Number(env.RELEASE_PR) : null,
    approver: env.APPROVER || null,
    prs: env.DEPENDENCY_PRS ? env.DEPENDENCY_PRS.split(',').map(Number) : [],
    workflowSha,
    domain: host,
    runUrl: env.RUN_URL,
    account,
  }
  // The manifest first, so the deployment record names it from the start.
  const stored = await waitForManifest({ store, site, commit, rebuild: storedRef, account })
  base.manifestSha256 = hashes(stored.body).sha256
  // The wait above can last 20 minutes: a go-live release asks again, right before anything is written, so names that
  // moved meanwhile stop it.
  if (env.KIND === 'go-live') {
    const again = await findLive(store, site)
    const late = goLiveRefusal(env.KIND, { ...again, site })
    if (late || again.distributionId !== distributionId) throw new Error(late ?? `${site}'s distribution changed from ${distributionId} to ${again.distributionId} while waiting`)
  }
  if (rebuild) {
    const late = contentRefusal(env.KIND, { distributionId, domain, site, commit, liveSha: await liveNow() })
    if (late) throw new Error(late)
  }
  if (env.KIND === 'refresh') {
    const late = refreshRefusal(env.KIND, { commit, liveSha: await liveNow() })
    if (late) throw new Error(late)
  }

  const what = describe({ kind: base.kind, pr: base.pr, approver: base.approver, prs: base.prs, commit, rebuild, refresh })
  const deployment = await gh(token, `/repos/${repo}/deployments`, {
    method: 'POST',
    body: {
      ref: commit,
      environment,
      auto_merge: false,
      required_contexts: [],
      production_environment: true,
      description: `${commit.slice(0, 7)} to ${host}: ${what}`.slice(0, 140),
      payload: deploymentPayload(base),
    },
  })
  const status = (state, description) =>
    gh(token, `/repos/${repo}/deployments/${deployment.id}/statuses`, {
      method: 'POST',
      body: { state, environment_url: `https://${host}`, log_url: env.RUN_URL, description: description.slice(0, 140) },
    })
  await status('in_progress', 'publishing')

  try {
    const result = await publishLive({ store, site, repo, commit, rebuild: storedRef, account, distributionId, stored, maxShare })
    const siteProblems = await checkLiveSite({ domain, site, host, files: result.files })
    summary(
      `### Live\n\nhttps://${host}: ${result.copies} copied, ${result.deletes} deleted, ${result.unchanged} unchanged, cache cleared (${result.invalidation}).\n\n` +
        `Commit \`${commit}\`, ${what}, manifest SHA-256 \`${result.manifestSha256}\`.` +
        (result.kept ? keptSummary(result) : ''),
    )
    if (siteProblems.length) {
      await status('failure', `published, but live checks failed: ${siteProblems[0]}`)
      throw new Error(`published, but the live site checks failed:\n${siteProblems.join('\n')}`)
    }
    await status('success', `live; manifest ${result.manifestSha256}`)
    console.log(`released ${commit} to https://${host} (${what}; manifest ${result.manifestSha256})`)
  } catch (err) {
    if (!/^published, but/.test(err.message)) await status('failure', err.message.split('\n')[0])
    throw err
  }
}

const STEPS = { verify: verifyMain, publish: publishMain }
runIfMain(import.meta.url, async () => {
  const step = STEPS[process.argv[2]]
  if (!step) throw new Error('usage: release.mjs verify|publish')
  await step()
})

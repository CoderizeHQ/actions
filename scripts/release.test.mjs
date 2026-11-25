// A dry run of release's verify and publish steps: GitHub's answers stubbed, S3 in memory, the live site faked.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { manifestKey, PREVIEW_BUCKET, storedKey } from './lib/build.mjs'
import { hashes } from './lib/files.mjs'
import { memoryStore } from './lib/memoryStore.mjs'
import {
  checkLiveSite,
  contentRefusal,
  deploymentEnvironment,
  deploymentPayload,
  describe,
  findLive,
  goLiveRefusal,
  HOLD_MARKER,
  holdLine,
  isSiteHost,
  KINDS,
  publishLive,
  robotsProblems,
  verify,
} from './release.mjs'

const site = 'sbmcdn-com'
const domain = 'sbmcdn.com'
const repo = 'CoderizeHQ/gate-test-web'
const commit = '1'.repeat(40)
const live = `coderizehq-live-${site}`
const quiet = { log: () => {} }

const robots = 'User-agent: *\nAllow: /\n\nSitemap: https://sbmcdn.com/sitemap-index.xml\n'
const files = {
  'index.html': '<h1>home</h1>',
  'about/index.html': '<h1>about</h1>',
  'robots.txt': robots,
  'sitemap-index.xml': '<?xml version="1.0"?><sitemapindex></sitemapindex>',
}

function storedBuild(store, which = files) {
  const manifest = { version: 1, site, repo, commit, workflow_sha: '2'.repeat(40), lockfile_sha256: '3'.repeat(64), created: 'x', files: {} }
  for (const [name, body] of Object.entries(which)) {
    store.seed(PREVIEW_BUCKET, storedKey(site, commit, name), body)
    manifest.files[name] = { size: Buffer.byteLength(body), sha256: hashes(Buffer.from(body)).sha256 }
  }
  store.seed(PREVIEW_BUCKET, manifestKey(site, commit), JSON.stringify(manifest))
  return manifest
}

const stub = (release, dependency) => ({
  checkRelease: async () => release,
  checkDependencyRun: async () => dependency,
})

test('verify: a good version tag on this commit publishes', async () => {
  const checks = stub({ ok: true, reasons: [], sha: commit, tag: 'v1.2.3', pr: 12, approver: 'GilbertJames' })
  const r = await verify({ token: 't', repo, ref: 'refs/tags/v1.2.3', sha: commit, checks })
  assert.deepEqual(r, { publish: true, kind: 'version', refreshable: true, pr: 12, approver: 'GilbertJames', reasons: [] })
})

test('verify: a tag on a non-release commit is refused', async () => {
  const checks = stub({ ok: false, reasons: ['the commit is not the merge of a pull request'], sha: commit, pr: null, approver: null })
  const r = await verify({ token: 't', repo, ref: 'refs/tags/v1.2.3', sha: commit, checks })
  assert.equal(r.publish, false)
})

test('verify: a tag pointing elsewhere than the run, or a non-version tag or branch, is refused', async () => {
  const checks = stub({ ok: true, reasons: [], sha: '9'.repeat(40), pr: 12, approver: 'GilbertJames' })
  assert.equal((await verify({ token: 't', repo, ref: 'refs/tags/v1.2.3', sha: commit, checks })).publish, false)
  for (const ref of ['refs/tags/v1', 'refs/tags/v1.2.3-rc.1', 'refs/tags/release', 'refs/heads/feature/x', 'refs/pull/1/merge']) {
    const r = await verify({ token: 't', repo, ref, sha: commit, checks })
    assert.equal(r.publish, false, ref)
    assert.match(r.reasons[0], /only for a version tag/)
  }
})

test('verify: main publishes a clean dependency gap, refuses a dirty one, and skips an empty one', async () => {
  const clean = stub(null, { ok: true, nothing: false, reasons: [], prs: [7, 8] })
  assert.deepEqual(await verify({ token: 't', repo, ref: 'refs/heads/main', sha: commit, checks: clean }), {
    publish: true, kind: 'dependency', refreshable: true, pr: null, approver: null, prs: [7, 8], reasons: [],
  })
  const dirty = stub(null, { ok: false, nothing: false, reasons: ['#9 was not opened by Renovate'], prs: [9] })
  const r = await verify({ token: 't', repo, ref: 'refs/heads/main', sha: commit, checks: dirty })
  assert.equal(r.publish, false)
  assert.match(r.reasons.at(-1), /left for James/)
  const empty = stub(null, { ok: true, nothing: true, reasons: [], prs: [] })
  assert.equal((await verify({ token: 't', repo, ref: 'refs/heads/main', sha: commit, checks: empty })).nothing, true)
})

test('verify: a refused dependency gap is a hold for James, naming the last release; the decision is unchanged', async () => {
  const dirty = stub(null, { ok: false, nothing: false, reasons: ['#9 was not opened by Renovate'], prs: [9], base: { sha: '4'.repeat(40), tag: 'v1.4.2' } })
  assert.deepEqual(await verify({ token: 't', repo, ref: 'refs/heads/main', sha: commit, checks: dirty }), {
    publish: false,
    hold: true,
    base: 'v1.4.2',
    reasons: ['#9 was not opened by Renovate', 'dependency-only release left for James'],
  })
  // No release yet: still a hold, with no base.
  const first = stub(null, { ok: false, nothing: false, reasons: ['no earlier release by the release App: the first release must be a version tag'], prs: [], base: null })
  assert.equal((await verify({ token: 't', repo, ref: 'refs/heads/main', sha: commit, checks: first })).base, null)
  // Nothing else is a hold: a clean or empty gap, a refused tag, a bad dispatch, a refused refresh.
  const clean = stub({ ok: false, reasons: ['not a release'], sha: commit }, { ok: true, nothing: false, reasons: [], prs: [7] })
  assert.equal((await verify({ token: 't', repo, ref: 'refs/heads/main', sha: commit, checks: clean })).hold, undefined)
  assert.equal((await verify({ token: 't', repo, ref: 'refs/heads/main', sha: commit, checks: stub(null, { ok: true, nothing: true, reasons: [], prs: [] }) })).hold, undefined)
  assert.equal((await verify({ token: 't', repo, ref: 'refs/tags/v1.2.3', sha: commit, checks: clean })).hold, undefined)
  assert.equal((await verify({ token: 't', repo, ref: 'refs/heads/feature/x', sha: commit, checks: clean })).hold, undefined)
  const goLiveElse = await verify({ token: 't', repo, ref: 'refs/heads/main', sha: commit, event: 'repository_dispatch', dispatch: 'go-live-release', sender: 'someone', site, payloadSite: site, checks: clean })
  assert.equal(goLiveElse.publish, false)
  assert.equal(goLiveElse.hold, undefined)
  const refresh = await verify({ token: 't', repo, ref: 'refs/heads/main', sha: commit, refresh: true, refreshResults: 'build=failure,store=skipped', checks: clean })
  assert.equal(refresh.publish, false)
  assert.equal(refresh.hold, undefined)
})

test("a hold's marker is one line the weekly digest can find, never a workflow command", () => {
  const line = holdLine({ reasons: ['#9 was not opened by Renovate', '::error::x\ny', 'dependency-only release left for James'], base: 'v1.4.2' })
  assert.equal(HOLD_MARKER, 'release-hold: ')
  assert.ok(line.startsWith(HOLD_MARKER))
  assert.doesNotMatch(line, /\n/)
  assert.deepEqual(JSON.parse(line.slice(HOLD_MARKER.length)), { reasons: ['#9 was not opened by Renovate', '::error::x\ny', 'dependency-only release left for James'], base: 'v1.4.2' })
  assert.equal(holdLine({ reasons: ['r'] }), 'release-hold: {"reasons":["r"],"base":null}')
})

test('publish: copies the stored build to live, deletes the rest, checks it, clears the cache', async () => {
  const store = memoryStore()
  storedBuild(store)
  store.seed(live, 'old.html', 'old page')
  store.seed(live, 'index.html', 'old home')
  store.seed(live, 'robots.txt', robots)

  const r = await publishLive({ store, site, repo, commit, distributionId: 'E1ABCDEF2GHIJ', ...quiet })
  assert.deepEqual([r.copies, r.deletes, r.unchanged], [3, 1, 1])
  assert.deepEqual((await store.list(live, '')).map((o) => o.key).sort(), Object.keys(files).sort())
  assert.deepEqual(store.invalidations, [{ distributionId: 'E1ABCDEF2GHIJ', paths: ['/*'] }])
  assert.ok(store.calls.some((c) => c[0] === 'waitInvalidation'), 'waits for the cache clear')
  for (const c of store.calls.filter((x) => x[0] === 'copy')) assert.match(c[1], new RegExp(`^${PREVIEW_BUCKET}/_builds/${site}/${commit}/files/`))
  assert.equal(store.calls.filter((x) => x[0] === 'put').length, 0, 'release never writes except by copy')
})

test('publish: a stored file that does not match the manifest stops before live is touched', async () => {
  const store = memoryStore()
  storedBuild(store)
  store.seed(PREVIEW_BUCKET, storedKey(site, commit, 'about/index.html'), 'tampered')
  await assert.rejects(publishLive({ store, site, repo, commit, distributionId: 'E1ABCDEF2GHIJ', ...quiet }), /doesn't match the manifest/)
  assert.equal(store.calls.filter((x) => x[0] === 'copy' || x[0] === 'delete').length, 0)
})

test('publish: no stored build means no release', async () => {
  const store = memoryStore()
  await assert.rejects(publishLive({ store, site, repo, commit, distributionId: 'E1ABCDEF2GHIJ', waitMs: 0, pollMs: 0, ...quiet }), /no stored build/)
})

test('publish: a mass delete on live is refused', async () => {
  const store = memoryStore()
  storedBuild(store)
  for (let i = 0; i < 50; i++) store.seed(live, `page-${i}/index.html`, `p${i}`)
  await assert.rejects(publishLive({ store, site, repo, commit, distributionId: 'E1ABCDEF2GHIJ', ...quiet }), /would delete 50 of 50/)
})

test('robots.txt that blocks everything or names no sitemap is a problem', () => {
  assert.deepEqual(robotsProblems(robots), [])
  assert.match(robotsProblems('User-agent: *\nDisallow: /\nSitemap: https://x/s.xml')[0], /disallows every crawler/)
  assert.deepEqual(robotsProblems('User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\nSitemap: https://x/s.xml'), [])
  assert.match(robotsProblems('User-agent: *\nAllow: /')[0], /no Sitemap/)
})

function fakeSite(pages) {
  return async (url) => {
    const body = pages[new URL(url).pathname]
    return { status: body === undefined ? 404 : 200, url, arrayBuffer: async () => Buffer.from(body ?? 'not found') }
  }
}
const built = Object.entries(files).map(([path, body]) => ({ path, size: Buffer.byteLength(body), sha256: hashes(Buffer.from(body)).sha256 }))

test('live checks pass when the site serves this build', async () => {
  const fetchImpl = fakeSite({ '/': files['index.html'], '/robots.txt': robots, '/sitemap-index.xml': files['sitemap-index.xml'] })
  assert.deepEqual(await checkLiveSite({ domain, files: built, fetchImpl, waitMs: 0, ...quiet }), [])
})

test('live checks fail on an old home page, a missing sitemap or a sitemap on another host', async () => {
  const old = fakeSite({ '/': 'old home', '/robots.txt': robots, '/sitemap-index.xml': files['sitemap-index.xml'] })
  assert.match((await checkLiveSite({ domain, files: built, fetchImpl: old, waitMs: 0, ...quiet }))[0], /home page/)
  const noMap = fakeSite({ '/': files['index.html'], '/robots.txt': robots })
  assert.match((await checkLiveSite({ domain, files: built, fetchImpl: noMap, waitMs: 0, ...quiet })).join(' '), /sitemap .* answered 404/)
  const elsewhere = 'User-agent: *\nAllow: /\nSitemap: https://sbmcdn-com.preview.coderize.dev/sitemap-index.xml\n'
  const withElsewhere = built.map((f) => (f.path === 'robots.txt' ? { ...f, size: elsewhere.length, sha256: hashes(Buffer.from(elsewhere)).sha256 } : f))
  const other = fakeSite({ '/': files['index.html'], '/robots.txt': elsewhere })
  assert.match((await checkLiveSite({ domain, files: withElsewhere, fetchImpl: other, waitMs: 0, ...quiet })).join(' '), /another host/)
})

test('with noindex, robots.txt must shut every crawler out and name no Sitemap', () => {
  assert.deepEqual(robotsProblems('User-agent: *\nDisallow: /\n', { noindex: true }), [])
  assert.match(robotsProblems(robots, { noindex: true }).join(' '), /must disallow every crawler/)
  assert.match(robotsProblems('User-agent: *\nDisallow: /\nSitemap: https://x/s.xml', { noindex: true }).join(' '), /names a Sitemap/)
  assert.match(robotsProblems('User-agent: GPTBot\nDisallow: /\n', { noindex: true }).join(' '), /must disallow every crawler/)
  assert.match(robotsProblems('User-agent: *\nDisallow: /\nUser-agent: Googlebot\nAllow: /\n', { noindex: true }).join(' '), /group for googlebot doesn't disallow/)
  assert.match(robotsProblems('User-agent: *\nDisallow: /\nAllow: /e/\n', { noindex: true }).join(' '), /allows \/e\//)
  // Indexed, the default, still refuses it.
  assert.match(robotsProblems('User-agent: *\nDisallow: /\n').join(' '), /disallows every crawler/)
})

// A site served by platform's live noindex headers policy ("indexed": false): every response has X-Robots-Tag.
function noindexSite(pages, tag = 'noindex') {
  const serve = fakeSite(pages)
  const fetched = []
  const fetchImpl = async (url) => {
    fetched.push(new URL(url).pathname)
    return { ...(await serve(url)), headers: new Headers(tag ? { 'x-robots-tag': tag } : {}) }
  }
  return { fetchImpl, fetched }
}

test('live checks of a noindex site want a robots.txt that shuts crawlers out, and fetch no sitemap', async () => {
  const closed = 'User-agent: *\nDisallow: /\n'
  const closedBuild = built.map((f) => (f.path === 'robots.txt' ? { ...f, size: closed.length, sha256: hashes(Buffer.from(closed)).sha256 } : f))
  const ok = noindexSite({ '/': files['index.html'], '/robots.txt': closed })
  assert.deepEqual(await checkLiveSite({ domain, files: closedBuild, fetchImpl: ok.fetchImpl, waitMs: 0, ...quiet }), [])
  assert.ok(!ok.fetched.some((p) => p.includes('sitemap')))
  const open = noindexSite({ '/': files['index.html'], '/robots.txt': robots, '/sitemap-index.xml': files['sitemap-index.xml'] }, 'noindex, nofollow')
  const problems = (await checkLiveSite({ domain, files: built, fetchImpl: open.fetchImpl, waitMs: 0, ...quiet })).join(' ')
  assert.match(problems, /must disallow every crawler/)
  assert.match(problems, /names a Sitemap/)
  // Without the header the site is indexed, and a robots.txt that shuts crawlers out is refused as before.
  const plain = noindexSite({ '/': files['index.html'], '/robots.txt': closed }, null)
  assert.match((await checkLiveSite({ domain, files: closedBuild, fetchImpl: plain.fetchImpl, waitMs: 0, ...quiet })).join(' '), /disallows every crawler/)
})

test('the deployment payload names the commit, PR, approver and manifest', () => {
  const p = deploymentPayload({ kind: 'version', commit, pr: 12, approver: 'GilbertJames', manifestSha256: 'f'.repeat(64), workflowSha: '2'.repeat(40), domain, runUrl: 'https://run' })
  assert.deepEqual(
    [p.commit, p.release_pr, p.approver, p.manifest_sha256, p.site_url],
    [commit, 12, 'GilbertJames', 'f'.repeat(64), 'https://sbmcdn.com'],
  )
})

test('the live distribution is found by its comment, and the domain from its aliases', async () => {
  const store = memoryStore()
  store.distributions.push(
    { id: 'EOTHER1', comment: 'other-com', aliases: ['other.com', 'www.other.com'] },
    { id: 'E1ABCDEF2GHIJ', comment: site, aliases: ['www.sbmcdn.com', 'sbmcdn.com'] },
  )
  assert.deepEqual(await findLive(store, site), { distributionId: 'E1ABCDEF2GHIJ', domain: 'sbmcdn.com', host: 'sbmcdn.com' })
  await assert.rejects(findLive(store, 'missing-com'), /no CloudFront distribution/)
  store.distributions.push({ id: 'EBAD', comment: 'bad-com', aliases: ['elsewhere.com'] })
  await assert.rejects(findLive(store, 'bad-com'), /no alias matching/)
  store.distributions.push({ id: 'EDUP', comment: site, aliases: [] })
  await assert.rejects(findLive(store, site), /2 distributions/)
})

// platform's alias_move: the distribution is made without aliases while the old fleet still serves the domain, and the
// release publishes to it before the names move over (CloudFront update-domain-association).
test('a distribution with no aliases yet (an alias move) is released to and checked on its own cloudfront.net name', async () => {
  const store = memoryStore()
  store.distributions.push({ id: 'EMOVE', comment: site, domainName: 'd111111abcdef8.cloudfront.net', aliases: [] })
  assert.deepEqual(await findLive(store, site), { distributionId: 'EMOVE', domain: null, host: 'd111111abcdef8.cloudfront.net' })
  // Some aliases, none of them the site's: still refused.
  store.distributions.push({ id: 'EOTHER', comment: 'other-com', domainName: 'd2.cloudfront.net', aliases: ['www.other.com'] })
  await assert.rejects(findLive(store, 'other-com'), /no alias matching/)
})

test('before an alias move, the live checks ask the distribution and fetch the sitemap by its path there', async () => {
  const asked = []
  const pages = { '/': files['index.html'], '/robots.txt': robots, '/sitemap-index.xml': files['sitemap-index.xml'] }
  const fetchImpl = async (url) => {
    asked.push(url)
    const u = new URL(url)
    // The domain itself still reaches the old site.
    const body = u.hostname === 'd111111abcdef8.cloudfront.net' ? pages[u.pathname] : 'old site'
    return { status: body === undefined ? 404 : 200, url, arrayBuffer: async () => Buffer.from(body ?? 'not found') }
  }
  const host = 'd111111abcdef8.cloudfront.net'
  assert.deepEqual(await checkLiveSite({ domain: null, site, host, files: built, fetchImpl, waitMs: 0, ...quiet }), [])
  assert.deepEqual(asked, [`https://${host}/`, `https://${host}/robots.txt`, `https://${host}/sitemap-index.xml`])
  // A sitemap on a host that isn't the site's is still refused.
  const elsewhere = 'User-agent: *\nAllow: /\nSitemap: https://other.com/sitemap-index.xml\n'
  const withElsewhere = built.map((f) => (f.path === 'robots.txt' ? { ...f, size: elsewhere.length, sha256: hashes(Buffer.from(elsewhere)).sha256 } : f))
  const other = async (url) => ({ status: 200, url, arrayBuffer: async () => Buffer.from(new URL(url).pathname === '/robots.txt' ? elsewhere : files['index.html']) })
  assert.match((await checkLiveSite({ domain: null, site, host, files: withElsewhere, fetchImpl: other, waitMs: 0, ...quiet })).join(' '), /another host/)
})

test("a sitemap's host is the site's domain or www; before an alias move, the name whose dots as hyphens are the site", () => {
  assert.equal(isSiteHost('sbmcdn.com', { domain, site }), true)
  assert.equal(isSiteHost('www.sbmcdn.com', { domain, site }), true)
  assert.equal(isSiteHost('cdn.sbmcdn.com', { domain, site }), false)
  assert.equal(isSiteHost('sbmcdn.com', { domain: null, site }), true)
  assert.equal(isSiteHost('www.sbmcdn.com', { domain: null, site }), true)
  assert.equal(isSiteHost('sbmcdn-com.preview.coderize.dev', { domain: null, site }), false)
  assert.equal(isSiteHost('wwwxsbmcdn.com', { domain: null, site }), false)
})

test("the deployment is recorded under live, or a site's own live-<site> when it shares its repo", () => {
  assert.equal(deploymentEnvironment('example-com'), 'live')
  assert.equal(deploymentEnvironment('example-com', ''), 'live')
  assert.equal(deploymentEnvironment('admin-example-com', 'live-admin-example-com'), 'live-admin-example-com')
  // Never another site's environment, and nothing else.
  assert.throws(() => deploymentEnvironment('admin-example-com', 'live-example-com'), /live or live-admin-example-com/)
  assert.throws(() => deploymentEnvironment('example-com', 'production'), /live or live-example-com/)
})

// platform's go-live: its apply sends go-live-release, as the platform App, for a site whose new distribution has no
// aliases yet, so the site's first publish needs no release PR (platform docs/go-live.md).
const goLive = { token: 't', repo, ref: 'refs/heads/main', sha: commit, event: 'repository_dispatch', dispatch: 'go-live-release', sender: 'coderizehq-platform[bot]', site, payloadSite: site }

test("verify: platform's go-live dispatch for this site publishes main's head, with no release check", async () => {
  const never = { checkRelease: async () => assert.fail('no release check'), checkDependencyRun: async () => assert.fail('no dependency check') }
  assert.deepEqual(await verify({ ...goLive, checks: never }), { publish: true, kind: 'go-live', pr: null, approver: null, reasons: [] })
})

test('verify: a go-live dispatch from anyone else, for another site, or off main is refused, never treated as a dependency run', async () => {
  const never = { checkRelease: async () => assert.fail('no release check'), checkDependencyRun: async () => assert.fail('no dependency check') }
  const release = await verify({ ...goLive, sender: 'coderizehq-release[bot]', checks: never })
  assert.equal(release.publish, false)
  assert.match(release.reasons[0], /comes only from platform's apply \(coderizehq-platform\[bot\]\), not coderizehq-release\[bot\]/)
  const other = await verify({ ...goLive, payloadSite: 'other-com', checks: never })
  assert.deepEqual(other.reasons, [`this go-live release names other-com, not ${site}`])
  const none = await verify({ ...goLive, payloadSite: '', checks: never })
  assert.match(none.reasons[0], /names no site/)
  const tag = await verify({ ...goLive, ref: 'refs/tags/v1.2.3', checks: never })
  assert.match(tag.reasons[0], /runs only on main, not refs\/tags\/v1\.2\.3/)
})

test("verify: the weekly dispatch on main is still the dependency run", async () => {
  const clean = stub(null, { ok: true, prs: [7], reasons: [] })
  const r = await verify({ ...goLive, dispatch: 'weekly-dependency-release', sender: 'coderizehq-release[bot]', checks: clean })
  assert.equal(r.kind, 'dependency')
})

test('publish: a go-live release goes only to a distribution with no aliases yet; one serving its domain is refused', () => {
  assert.equal(goLiveRefusal('go-live', { distributionId: 'EMOVE', domain: null, site }), null)
  assert.match(goLiveRefusal('go-live', { distributionId: 'ELIVE', domain, site }), /^a go-live release publishes only to a distribution with no aliases yet \(before its alias move\), but ELIVE serves sbmcdn\.com/)
  assert.equal(goLiveRefusal('version', { distributionId: 'ELIVE', domain, site }), null)
  assert.ok(KINDS.includes('go-live'))
  assert.equal(describe({ kind: 'go-live' }), "go-live release of main's head, before the alias move")
  assert.equal(describe({ kind: 'dependency', prs: [3] }), 'dependency-only: Renovate PRs #3')
})

test('release.yml hands verify the event, the dispatch, its sender and its site, as environment only', async () => {
  const { readFileSync } = await import('node:fs')
  const wf = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const verifyStep = wf.slice(wf.indexOf('- name: Verify the release'), wf.indexOf('release.mjs verify'))
  for (const line of ['SITE: ${{ inputs.site }}', 'EVENT: ${{ github.event_name }}', 'DISPATCH: ${{ github.event.action }}', 'SENDER: ${{ github.event.sender.login }}', 'PAYLOAD_SITE: ${{ github.event.client_payload.site }}']) {
    assert.ok(verifyStep.includes(line), line)
  }
  for (const l of wf.split('\n')) if (/run: /.test(l)) assert.doesNotMatch(l, /github\.event\./, l)
})

test('describe names every kind and refuses an unknown one', () => {
  assert.equal(describe({ kind: 'version', pr: 9, approver: 'GilbertJames' }), 'release PR #9, approved by GilbertJames')
  assert.throws(() => describe({ kind: 'manual' }), /unknown release kind manual/)
})

test("verify: a go-live dispatch's sender and site are shown tamed, so they can't add lines or workflow commands", async () => {
  const never = { checkRelease: async () => assert.fail('no release check'), checkDependencyRun: async () => assert.fail('no dependency check') }
  const r = await verify({ ...goLive, sender: 'x\n::error::fake', payloadSite: `a-com\n## injected${'z'.repeat(100)}`, checks: never })
  assert.equal(r.publish, false)
  for (const reason of r.reasons) {
    assert.doesNotMatch(reason, /\n/)
    assert.doesNotMatch(reason, /::error::|##/)
  }
  assert.match(r.reasons[1], /names a-com\?\?\?\?injectedz+, not sbmcdn-com$/)
  assert.ok(r.reasons[1].length < 120)
})

// platform's content check: a content-rebuild dispatch, as the release App, for a live site whose build-time content
// changed. verify finds the live commit itself (lib/rebuild.mjs, stubbed here) and publish takes this run's rebuild.
const content = 'c'.repeat(64)
const rebuildDispatch = { token: 't', repo, ref: 'refs/heads/main', sha: '9'.repeat(40), event: 'repository_dispatch', dispatch: 'content-rebuild', sender: 'coderizehq-release[bot]', site, payloadSite: site, payloadContent: content }
const never = { checkRelease: async () => assert.fail('no release check'), checkDependencyRun: async () => assert.fail('no dependency check') }

test("verify: a content rebuild publishes the live commit findTarget re-checked, never the run's (main's head)", async () => {
  const environments = []
  const findTarget = async ({ environment }) => (environments.push(environment), { ok: true, sha: commit, basis: 'version', tag: 'v1.4.0', pr: 12, approver: 'GilbertJames', prs: [] })
  const r = await verify({ ...rebuildDispatch, environment: 'live', checks: { ...never, findTarget } })
  assert.deepEqual(r, {
    publish: true,
    kind: 'content',
    commit,
    pr: 12,
    approver: 'GilbertJames',
    prs: [],
    rebuild: { basis: 'version', tag: 'v1.4.0', contentSha256: content },
    reasons: [],
  })
  assert.deepEqual(environments, ['live'])
})

test('verify: a content rebuild that findTarget refuses, or a bad dispatch, publishes nothing and is never a dependency run', async () => {
  const refuse = async () => ({ ok: false, reasons: ['live 1111111 is the go-live release'] })
  assert.deepEqual(await verify({ ...rebuildDispatch, checks: { ...never, findTarget: refuse } }), { publish: false, reasons: ['live 1111111 is the go-live release'] })
  const noLookup = async () => assert.fail('no lookup for a bad dispatch')
  for (const bad of [{ sender: 'coderizehq-platform[bot]' }, { payloadSite: 'other-com' }, { payloadContent: 'nope' }, { ref: 'refs/tags/v1.4.0' }]) {
    const r = await verify({ ...rebuildDispatch, ...bad, checks: { ...never, findTarget: noLookup } })
    assert.equal(r.publish, false, JSON.stringify(bad))
  }
  // Another site's deployments are never read.
  await assert.rejects(verify({ ...rebuildDispatch, environment: 'live-other-com', checks: { ...never, findTarget: noLookup } }), /live or live-sbmcdn-com/)
})

test("publish: a content rebuild copies this run's stored rebuild, never the commit's first build", async () => {
  const store = memoryStore()
  storedBuild(store, { 'index.html': 'first build', 'robots.txt': robots })
  const run = '4242'
  const rebuilt = { 'index.html': '<h1>new events</h1>', 'events/new/index.html': '<h1>new</h1>', 'robots.txt': robots }
  const manifest = { version: 1, site, repo, commit, workflow_sha: '2'.repeat(40), lockfile_sha256: '3'.repeat(64), created: 'x', rebuild: { run, content_sha256: content }, files: {} }
  for (const [name, body] of Object.entries(rebuilt)) {
    store.seed(PREVIEW_BUCKET, storedKey(site, commit, name, run), body)
    manifest.files[name] = { size: Buffer.byteLength(body), sha256: hashes(Buffer.from(body)).sha256 }
  }
  store.seed(PREVIEW_BUCKET, manifestKey(site, commit, run), JSON.stringify(manifest))
  await publishLive({ store, site, repo, commit, rebuild: run, distributionId: 'E1ABCDEF2GHIJ', ...quiet })
  assert.equal((await store.get(live, 'index.html')).body.toString(), '<h1>new events</h1>')
  for (const c of store.calls.filter((x) => x[0] === 'copy')) assert.match(c[1], new RegExp(`^${PREVIEW_BUCKET}/_builds/${site}/${commit}/rebuilds/${run}/files/`))
  // The commit's first build's manifest isn't a rebuild's, and another run's rebuild isn't this one's.
  await assert.rejects(publishLive({ store, site, repo, commit, rebuild: '4243', distributionId: 'E1ABCDEF2GHIJ', waitMs: 0, pollMs: 0, ...quiet }), /no stored build/)
  store.seed(PREVIEW_BUCKET, manifestKey(site, commit, '4244'), JSON.stringify(manifest))
  await assert.rejects(publishLive({ store, site, repo, commit, rebuild: '4244', distributionId: 'E1ABCDEF2GHIJ', ...quiet }), /isn't content rebuild 4244's/)
})

test('publish: a content rebuild goes only to a site live on its domain, and only while live still runs its commit', () => {
  const at = { distributionId: 'ELIVE', domain, site, commit, liveSha: commit }
  assert.equal(contentRefusal('content', at), null)
  assert.match(contentRefusal('content', { ...at, domain: null, distributionId: 'EMOVE' }), /EMOVE serves no name yet \(an alias move under way\)/)
  assert.match(contentRefusal('content', { ...at, liveSha: '8'.repeat(40) }), /live moved from 1111111 to 8888888 since this content rebuild found its target/)
  assert.match(contentRefusal('content', { ...at, liveSha: null }), /to nothing/)
  // Every other kind is someone else's check.
  assert.equal(contentRefusal('version', { ...at, liveSha: '8'.repeat(40) }), null)
})

test("a content rebuild's deployment names its run, what it rebuilt and the content hash; other kinds have no rebuild field", () => {
  const rebuild = { run: '4242', basis: 'version', tag: 'v1.4.0', contentSha256: content }
  const p = deploymentPayload({ kind: 'content', commit, pr: 12, approver: 'GilbertJames', manifestSha256: 'f'.repeat(64), workflowSha: '2'.repeat(40), domain, runUrl: 'https://run', rebuild })
  assert.equal(p.kind, 'content')
  assert.deepEqual(p.rebuild, { run: '4242', basis: 'version', tag: 'v1.4.0', content_sha256: content })
  assert.equal('rebuild' in deploymentPayload({ kind: 'version', commit, workflowSha: '2'.repeat(40), domain, runUrl: 'x' }), false)
  assert.ok(KINDS.includes('content'))
  assert.equal(describe({ kind: 'content', commit, rebuild }), 'content rebuild of v1.4.0 (1111111), content cccccccccccc')
})

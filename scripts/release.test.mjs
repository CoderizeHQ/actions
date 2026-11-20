// A dry run of release's verify and publish steps: GitHub's answers stubbed, S3 in memory, the live site faked.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { manifestKey, PREVIEW_BUCKET, storedKey } from './lib/build.mjs'
import { hashes } from './lib/files.mjs'
import { memoryStore } from './lib/memoryStore.mjs'
import { checkLiveSite, deploymentEnvironment, deploymentPayload, findLive, isSiteHost, publishLive, robotsProblems, verify } from './release.mjs'

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
  assert.deepEqual(r, { publish: true, kind: 'version', pr: 12, approver: 'GilbertJames', reasons: [] })
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
    publish: true, kind: 'dependency', pr: null, approver: null, prs: [7, 8], reasons: [],
  })
  const dirty = stub(null, { ok: false, nothing: false, reasons: ['#9 was not opened by Renovate'], prs: [9] })
  const r = await verify({ token: 't', repo, ref: 'refs/heads/main', sha: commit, checks: dirty })
  assert.equal(r.publish, false)
  assert.match(r.reasons.at(-1), /left for James/)
  const empty = stub(null, { ok: true, nothing: true, reasons: [], prs: [] })
  assert.equal((await verify({ token: 't', repo, ref: 'refs/heads/main', sha: commit, checks: empty })).nothing, true)
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

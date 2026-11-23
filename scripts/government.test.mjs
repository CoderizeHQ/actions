// A government site (G5 of the EMCOG move): the `account` input on deploy-preview and release, the builds in the
// Government account's locked bucket, its publish role, and never delete. Live sites must behave exactly as before;
// the other test files prove that with no `account` at all, and these check the live default explicitly too.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { CopyObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

import { publishPreview, storeBuild } from './deployPreview.mjs'
import { awsStore, KVS_PAGE, s3Client } from './lib/aws.mjs'
import {
  ACCOUNTS,
  buildsBucket,
  checkAccount,
  GOVERNMENT_ACCOUNT,
  GOVERNMENT_BUILDS_BUCKET,
  GOVERNMENT_REDIRECT_STORE,
  isPage,
  LIVE_ACCOUNT,
  liveRoleArn,
  manifestKey,
  neverDeletePlan,
  pageUrl,
  PREVIEW_BUCKET,
  redirectCovers,
  storedKey,
} from './lib/build.mjs'
import { hashes } from './lib/files.mjs'
import { memoryStore } from './lib/memoryStore.mjs'
import { deploymentPayload, keptSummary, neverDeleteRefusal, publishLive, waitForManifest } from './release.mjs'

const site = 'emcog-org'
const domain = 'emcog.org'
const repo = 'CoderizeHQ/emcog-org-web'
const commit = '1'.repeat(40)
const live = `coderizehq-live-${site}`
const quiet = { log: () => {} }
const distributionId = 'EGOV1234567890'

// --- The account map ---

test('account: live or government, a missing one is live, anything else is refused', () => {
  assert.equal(checkAccount(undefined), 'live')
  assert.equal(checkAccount(null), 'live')
  assert.equal(checkAccount('live'), 'live')
  assert.equal(checkAccount('government'), 'government')
  for (const bad of ['', 'Government', 'preview', 'toString', '__proto__', 'live ', '355600359887']) {
    assert.throws(() => checkAccount(bad), /account must be live or government/, JSON.stringify(bad))
  }
})

test('account map: live keeps 243891826043 and the preview bucket; government is 355600359887 and its locked bucket', () => {
  assert.deepEqual(Object.keys(ACCOUNTS), ['live', 'government'])
  assert.equal(LIVE_ACCOUNT, '243891826043')
  assert.equal(GOVERNMENT_ACCOUNT, '355600359887')
  assert.equal(GOVERNMENT_BUILDS_BUCKET, 'coderizehq-gov-builds-355600359887')
  assert.equal(GOVERNMENT_REDIRECT_STORE, 'coderizehq-government-redirects')
  assert.equal(buildsBucket(), PREVIEW_BUCKET)
  assert.equal(buildsBucket('live'), 'coderizehq-previews-798070830797')
  assert.equal(buildsBucket('government'), GOVERNMENT_BUILDS_BUCKET)
  assert.equal(liveRoleArn('sbmcdn-com'), 'arn:aws:iam::243891826043:role/coderizehq-live-publish-sbmcdn-com')
  assert.equal(liveRoleArn('sbmcdn-com', 'live'), 'arn:aws:iam::243891826043:role/coderizehq-live-publish-sbmcdn-com')
  assert.equal(liveRoleArn(site, 'government'), 'arn:aws:iam::355600359887:role/coderizehq-live-publish-emcog-org')
  assert.throws(() => liveRoleArn(site, 'other'), /account must be/)
  assert.equal(ACCOUNTS.live.neverDelete, false)
  assert.equal(ACCOUNTS.government.neverDelete, true)
})

// --- Never delete: pages, their URLs and redirects ---

test('a page is an .html object; its URL is the one the router serves it at', () => {
  assert.ok(isPage('index.html') && isPage('about/index.html') && isPage('old.htm') && isPage('a/B.HTML'))
  assert.ok(!isPage('_astro/app.js') && !isPage('archive-files/minutes.pdf') && !isPage('sitemap-index.xml') && !isPage('html'))
  assert.equal(pageUrl('index.html'), '/')
  assert.equal(pageUrl('about/index.html'), '/about')
  assert.equal(pageUrl('meetings/2024/index.html'), '/meetings/2024')
  assert.equal(pageUrl('404.html'), '/404.html')
  assert.equal(pageUrl('old/page.html'), '/old/page.html')
})

test('a redirect covers a page by its URL, as stored or percent-encoded', () => {
  const redirects = new Map([
    ['/about', '/who-we-are'],
    ['/Board%20Minutes.html', '/meetings'],
  ])
  assert.ok(redirectCovers(redirects, 'about/index.html'))
  assert.ok(redirectCovers(redirects, 'Board Minutes.html'))
  assert.ok(!redirectCovers(redirects, 'about.html'), '/about.html is another URL')
  assert.ok(!redirectCovers(new Map([['/about/index.html', '/x']]), 'about/index.html'), 'the page is served at /about, which would still 404')
})

test('neverDeletePlan keeps everything, and refuses only pages with no redirect', () => {
  const dropped = ['_astro/old.abc.js', 'about/index.html', 'gone/index.html', 'img/a.png']
  assert.deepEqual(neverDeletePlan(dropped, new Map([['/about', '/x']])), {
    kept: dropped,
    redirected: ['about/index.html'],
    refused: ['gone/index.html'],
  })
  assert.deepEqual(neverDeletePlan(['_astro/old.abc.js'], null), { kept: ['_astro/old.abc.js'], redirected: [], refused: [] })
  assert.deepEqual(neverDeletePlan([], null), { kept: [], redirected: [], refused: [] })
})

// --- deploy-preview ---

async function buildDir(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gov-build-'))
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await writeFile(path.join(dir, name), body)
  }
  return dir
}

const previewCommon = { site, repo, commit, workflowSha: '2'.repeat(40), lockfileSha256: '3'.repeat(64), ...quiet }

test("deploy-preview, government: the build goes to the Government account's locked bucket, the preview to the preview bucket", async () => {
  const store = memoryStore()
  const dir = await buildDir({ 'index.html': '<h1>EMCOG</h1>', 'about/index.html': '<h1>about</h1>' })
  const stored = await storeBuild({ store, buildDir: dir, bucket: buildsBucket('government'), ...previewCommon })
  assert.equal(stored.files.length, 2)
  assert.ok(store.locked.has(GOVERNMENT_BUILDS_BUCKET), 'the fake treats the builds bucket as Object-Locked')
  assert.ok(await store.get(GOVERNMENT_BUILDS_BUCKET, manifestKey(site, commit)), 'the manifest is in the government bucket')
  assert.equal(await store.get(PREVIEW_BUCKET, manifestKey(site, commit)), null, 'nothing stored in the preview account')
  for (const c of store.calls.filter((x) => x[0] === 'put')) assert.equal(c[1], GOVERNMENT_BUILDS_BUCKET)

  const result = await publishPreview({ store, site, commit, files: stored.files, builds: buildsBucket('government'), ...quiet })
  assert.equal(result.copies, 2)
  for (const c of store.calls.filter((x) => x[0] === 'copy')) {
    assert.match(c[1], new RegExp(`^${GOVERNMENT_BUILDS_BUCKET}/_builds/${site}/${commit}/files/`))
    assert.equal(c[2], PREVIEW_BUCKET)
    assert.match(c[3], new RegExp(`^sites/${site}/`))
  }
  assert.deepEqual((await store.list(PREVIEW_BUCKET, `sites/${site}/`)).map((o) => o.key).sort(), ['about/index.html', 'index.html'])
  await rm(dir, { recursive: true })
})

test('deploy-preview, live: the default bucket is still the preview account\'s, exactly as before', async () => {
  const store = memoryStore()
  const dir = await buildDir({ 'index.html': '<h1>home</h1>' })
  const stored = await storeBuild({ store, buildDir: dir, ...previewCommon, site: 'sbmcdn-com' })
  await publishPreview({ store, site: 'sbmcdn-com', commit, files: stored.files, ...quiet })
  assert.ok(await store.get(PREVIEW_BUCKET, manifestKey('sbmcdn-com', commit)))
  assert.equal(store.buckets.get(GOVERNMENT_BUILDS_BUCKET)?.size ?? 0, 0)
  for (const c of store.calls.filter((x) => x[0] === 'copy')) {
    assert.match(c[1], new RegExp(`^${PREVIEW_BUCKET}/_builds/`))
    assert.deepEqual(c[4], {}, 'a live copy asks for nothing extra')
  }
  await rm(dir, { recursive: true })
})

// --- release ---

const robots = 'User-agent: *\nAllow: /\n\nSitemap: https://emcog.org/sitemap-index.xml\n'
const files = {
  'index.html': '<h1>EMCOG</h1>',
  'about/index.html': '<h1>about</h1>',
  'meetings/index.html': '<h1>meetings</h1>',
  '_astro/app.NEW123.js': 'console.log(2)',
  'robots.txt': robots,
}

function storedBuild(store, which = files, bucket = GOVERNMENT_BUILDS_BUCKET) {
  const manifest = { version: 1, site, repo, commit, workflow_sha: '2'.repeat(40), lockfile_sha256: '3'.repeat(64), created: 'x', files: {} }
  for (const [name, body] of Object.entries(which)) {
    store.seed(bucket, storedKey(site, commit, name), body)
    manifest.files[name] = { size: Buffer.byteLength(body), sha256: hashes(Buffer.from(body)).sha256 }
  }
  store.seed(bucket, manifestKey(site, commit), JSON.stringify(manifest))
  return manifest
}

function govStore() {
  const store = memoryStore()
  store.lock(live)
  return store
}

const release = (store, extra = {}) => publishLive({ store, site, repo, commit, account: 'government', distributionId, ...quiet, ...extra })

test("release, government: the first release copies from the government bucket into the locked live bucket, with a checksum", async () => {
  const store = govStore()
  storedBuild(store)
  const r = await release(store)
  assert.deepEqual([r.copies, r.deletes, r.unchanged], [5, 0, 0])
  assert.deepEqual(r.kept, [])
  assert.deepEqual((await store.list(live, '')).map((o) => o.key).sort(), Object.keys(files).sort())
  const copies = store.calls.filter((x) => x[0] === 'copy')
  assert.equal(copies.length, 5)
  for (const c of copies) {
    assert.match(c[1], new RegExp(`^${GOVERNMENT_BUILDS_BUCKET}/_builds/${site}/${commit}/files/`))
    assert.equal(c[2], live)
    assert.deepEqual(c[4], { checksum: 'SHA256' })
  }
  assert.ok(!store.calls.some((c) => c[0] === 'redirects'), 'nothing dropped, so the redirect store is never read')
  assert.ok(!store.calls.some((c) => c[0] === 'delete'))
  assert.ok(!store.calls.some((c) => c[0] === 'get' && c[1] === PREVIEW_BUCKET), "the preview account's builds are never read")
})

test('release, government: a file the build dropped stays on live, and the release passes without reading redirects', async () => {
  const store = govStore()
  storedBuild(store)
  for (const [k, v] of Object.entries(files)) store.seed(live, k, v)
  store.seed(live, '_astro/app.OLD999.js', 'console.log(1)')
  store.seed(live, 'archive-files/minutes-2019.pdf', '%PDF-1.4 minutes')
  // 2 of 7 is more than the live account's 25%; a government site never deletes, so there is nothing to guard.
  const r = await release(store, { maxShare: 0 })
  assert.deepEqual([r.copies, r.deletes, r.unchanged], [0, 0, 5])
  assert.deepEqual(r.kept.sort(), ['_astro/app.OLD999.js', 'archive-files/minutes-2019.pdf'])
  assert.deepEqual(r.redirected, [])
  assert.ok(await store.get(live, '_astro/app.OLD999.js'), 'kept')
  assert.ok(await store.get(live, 'archive-files/minutes-2019.pdf'), 'kept')
  assert.ok(!store.calls.some((c) => c[0] === 'redirects'))
  assert.ok(!store.calls.some((c) => c[0] === 'delete'), 'never deletes')
  assert.match(keptSummary(r), /2 on live but not in the build stayed there \(nothing was deleted\): 0 redirected pages, 2 files/)
})

test('release, government: a dropped page with no redirect refuses the release before anything is written', async () => {
  const store = govStore()
  storedBuild(store, { ...files, 'index.html': '<h1>EMCOG, new</h1>' })
  for (const [k, v] of Object.entries(files)) store.seed(live, k, v)
  store.seed(live, 'board/index.html', '<h1>board</h1>')
  store.seed(live, 'old.htm', 'old')
  store.redirectStores.set(GOVERNMENT_REDIRECT_STORE, new Map([['emcog.org/old.htm', '/'], ['other.gov/board', '/x']]))
  await assert.rejects(release(store), (err) => {
    assert.match(err.message, /^emcog-org is a government site, whose releases never delete a page, but this build lacks 1 page live now with no redirect in its record:\n\/board \(board\/index\.html\)\n/)
    assert.match(err.message, /Nothing was published/)
    assert.doesNotMatch(err.message, /old\.htm/, 'the redirected page is not listed')
    return true
  })
  assert.deepEqual(store.calls.filter((c) => c[0] === 'redirects'), [['redirects', GOVERNMENT_REDIRECT_STORE, site]])
  assert.ok(!store.calls.some((c) => c[0] === 'copy' || c[0] === 'delete'), 'nothing copied, nothing deleted')
  assert.equal((await store.get(live, 'index.html')).body.toString(), files['index.html'], 'live is untouched')
})

test("release, government: another site's redirect for the same path doesn't count", async () => {
  const store = govStore()
  storedBuild(store)
  store.seed(live, 'board/index.html', '<h1>board</h1>')
  store.redirectStores.set(GOVERNMENT_REDIRECT_STORE, new Map([['other.gov/board', '/x'], ['@site/emcog.org', '1']]))
  await assert.rejects(release(store), /lacks 1 page live now with no redirect/)
})

test('release, government: a dropped page with a redirect passes, and the page stays (the router answers its URL first)', async () => {
  const store = govStore()
  storedBuild(store)
  for (const [k, v] of Object.entries(files)) store.seed(live, k, v)
  store.seed(live, 'board/index.html', '<h1>board</h1>')
  store.seed(live, 'Board Minutes.html', 'minutes')
  store.redirectStores.set(
    GOVERNMENT_REDIRECT_STORE,
    new Map([
      ['emcog.org/board', '/about'],
      ['emcog.org/Board%20Minutes.html', '/meetings'],
    ]),
  )
  const r = await release(store)
  assert.deepEqual(r.redirected.sort(), ['Board Minutes.html', 'board/index.html'])
  assert.deepEqual(r.kept.sort(), ['Board Minutes.html', 'board/index.html'])
  assert.ok(await store.get(live, 'board/index.html'), 'kept, never deleted')
  assert.ok(!store.calls.some((c) => c[0] === 'delete'))
  assert.match(keptSummary(r), /2 redirected pages, 0 files/)
})

test('release, government: the refusal lists at most 20 pages', () => {
  const refused = Array.from({ length: 25 }, (_, i) => `p${i}/index.html`)
  const msg = neverDeleteRefusal(site, refused)
  assert.match(msg, /lacks 25 pages/)
  assert.match(msg, /…and 5 more/)
  assert.equal(msg.split('\n').filter((l) => l.startsWith('/p')).length, 20)
})

test('release, government: the stored build is read from the government bucket only', async () => {
  const store = govStore()
  storedBuild(store, files, PREVIEW_BUCKET) // a build in the wrong account's bucket
  await assert.rejects(release(store, { waitMs: 0, pollMs: 0 }), /no stored build/)
  const got = await waitForManifest({ store, site, commit, account: 'live', waitMs: 0, ...quiet })
  assert.ok(got, "the live account's builds are where a live site's are")
})

test('release: an unknown account is refused before any store call', async () => {
  const store = govStore()
  storedBuild(store)
  await assert.rejects(publishLive({ store, site, repo, commit, account: 'other', distributionId, ...quiet }), /account must be live or government/)
  await assert.rejects(waitForManifest({ store, site, commit, account: '', ...quiet }), /account must be live or government/)
  assert.deepEqual(store.calls, [])
})

test('release, live: the default and an explicit live behave the same, deleting as before', async () => {
  const runs = []
  for (const account of [undefined, 'live']) {
    const store = memoryStore()
    const lsite = 'sbmcdn-com'
    const lbucket = `coderizehq-live-${lsite}`
    const manifest = { version: 1, site: lsite, repo, commit, workflow_sha: '2'.repeat(40), lockfile_sha256: '3'.repeat(64), created: 'x', files: {} }
    for (const [name, body] of Object.entries({ 'index.html': 'home', 'robots.txt': robots })) {
      store.seed(PREVIEW_BUCKET, storedKey(lsite, commit, name), body)
      manifest.files[name] = { size: Buffer.byteLength(body), sha256: hashes(Buffer.from(body)).sha256 }
    }
    store.seed(PREVIEW_BUCKET, manifestKey(lsite, commit), JSON.stringify(manifest))
    store.seed(lbucket, 'old/index.html', 'old page')
    const r = await publishLive({ store, site: lsite, repo, commit, distributionId, ...(account ? { account } : {}), ...quiet })
    assert.equal(r.deletes, 1)
    assert.equal('kept' in r, false)
    assert.equal(await store.get(lbucket, 'old/index.html'), null, 'a live site deletes what the build lacks')
    assert.ok(!store.calls.some((c) => c[0] === 'redirects'))
    for (const c of store.calls.filter((x) => x[0] === 'copy')) assert.deepEqual(c[4], {}, 'no checksum option on a live copy')
    runs.push(store.calls)
  }
  assert.deepEqual(runs[0], runs[1])
})

test('deployment payload: only a government release names its account', () => {
  const base = { kind: 'version', commit, pr: 1, approver: 'GilbertJames', prs: [], manifestSha256: 'm', workflowSha: 'w', domain, runUrl: 'u' }
  assert.equal('account' in deploymentPayload(base), false)
  assert.equal('account' in deploymentPayload({ ...base, account: 'live' }), false)
  assert.equal(deploymentPayload({ ...base, account: 'government' }).account, 'government')
})

// --- The AWS calls themselves (lib/aws.mjs), with the SDK's own request building and nothing sent ---

/** A real SDK client whose HTTP handler records each request and answers it, so nothing leaves the machine. */
function recordingHandler(answer) {
  const requests = []
  return {
    requests,
    handler: {
      handle: async (request) => {
        requests.push(request)
        const { status = 200, body = '' } = answer(request) ?? {}
        const { Readable } = await import('node:stream')
        return { response: { statusCode: status, headers: { 'content-type': 'application/xml' }, body: Readable.from([Buffer.from(body)]) } }
      },
    },
  }
}

const fakeCredentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }

test('uploads carry a SHA-256 checksum header (what a locked bucket needs), and the default calculation is pinned on', async () => {
  const before = process.env.AWS_REQUEST_CHECKSUM_CALCULATION
  process.env.AWS_REQUEST_CHECKSUM_CALCULATION = 'WHEN_REQUIRED'
  try {
    const rec = recordingHandler(() => ({ body: '' }))
    const s3 = s3Client({ credentials: fakeCredentials, requestHandler: rec.handler })
    assert.equal(await s3.config.requestChecksumCalculation(), 'WHEN_SUPPORTED', 'an environment asking for WHEN_REQUIRED does not turn it off')
    const store = awsStore({ s3, cloudfront: { send: async () => assert.fail('no CloudFront') } })
    const body = Buffer.from('<h1>EMCOG</h1>')
    await store.putIfAbsent(GOVERNMENT_BUILDS_BUCKET, storedKey(site, commit, 'index.html'), body, {
      contentType: 'text/html',
      cacheControl: 'no-cache',
      sha256: hashes(body).sha256,
    })
    const put = rec.requests[0]
    assert.equal(put.method, 'PUT')
    assert.equal(put.headers['x-amz-checksum-sha256'], Buffer.from(hashes(body).sha256, 'hex').toString('base64'))
    assert.equal(put.headers['if-none-match'], '*')
  } finally {
    if (before === undefined) delete process.env.AWS_REQUEST_CHECKSUM_CALCULATION
    else process.env.AWS_REQUEST_CHECKSUM_CALCULATION = before
  }
})

test("copies into a government bucket ask for a SHA-256 checksum; a live copy's request is what it always was", async () => {
  const sent = []
  const store = awsStore({ s3: { send: async (cmd) => (sent.push(cmd), { CopyObjectResult: { ETag: '"e"' } }) }, cloudfront: {} })
  await store.copy(GOVERNMENT_BUILDS_BUCKET, storedKey(site, commit, 'index.html'), live, 'index.html', { checksum: 'SHA256' })
  await store.copy(PREVIEW_BUCKET, storedKey('sbmcdn-com', commit, 'index.html'), 'coderizehq-live-sbmcdn-com', 'index.html')
  assert.ok(sent.every((c) => c instanceof CopyObjectCommand))
  assert.deepEqual(sent[0].input, {
    Bucket: live,
    Key: 'index.html',
    CopySource: `${GOVERNMENT_BUILDS_BUCKET}/_builds/${site}/${commit}/files/index.html`,
    MetadataDirective: 'COPY',
    ChecksumAlgorithm: 'SHA256',
  })
  assert.deepEqual(sent[1].input, {
    Bucket: 'coderizehq-live-sbmcdn-com',
    Key: 'index.html',
    CopySource: `${PREVIEW_BUCKET}/_builds/sbmcdn-com/${commit}/files/index.html`,
    MetadataDirective: 'COPY',
  })

  // And on the wire, through the real SDK: the copy carries x-amz-checksum-algorithm.
  const rec = recordingHandler(() => ({ body: '<CopyObjectResult><ETag>"e"</ETag></CopyObjectResult>' }))
  const real = awsStore({ s3: s3Client({ credentials: fakeCredentials, requestHandler: rec.handler }), cloudfront: {} })
  await real.copy(GOVERNMENT_BUILDS_BUCKET, storedKey(site, commit, 'index.html'), live, 'index.html', { checksum: 'SHA256' })
  assert.equal(rec.requests[0].headers['x-amz-checksum-algorithm'], 'SHA256')
  assert.equal(rec.requests[0].headers['x-amz-copy-source'], `${GOVERNMENT_BUILDS_BUCKET}/_builds/${site}/${commit}/files/index.html`)
  assert.ok(!(new PutObjectCommand({ Bucket: 'b', Key: 'k' }).input.ChecksumAlgorithm))
})

test("redirects: one site's paths from the store, found by name, every page of ListKeys", async () => {
  const cfCalls = []
  const kvsCalls = []
  const pages = [
    { Items: [{ Key: 'emcog.org/about', Value: '/who' }, { Key: '@site/emcog.org', Value: '1' }, { Key: 'other.gov/about', Value: '/x' }], NextToken: 't1' },
    { Items: [{ Key: 'emcog.org/Board%20Minutes.html', Value: '/meetings' }, { Key: 'emcog-org.com/nope', Value: '/no' }] },
  ]
  const store = awsStore({
    s3: {},
    cloudfront: { send: async (cmd) => (cfCalls.push(cmd.input), { KeyValueStore: { ARN: 'arn:aws:cloudfront::355600359887:key-value-store/abc' } }) },
    kvs: { send: async (cmd) => (kvsCalls.push(cmd.input), pages[kvsCalls.length - 1]) },
  })
  const map = await store.redirects(GOVERNMENT_REDIRECT_STORE, site)
  assert.deepEqual(cfCalls, [{ Name: GOVERNMENT_REDIRECT_STORE }])
  assert.deepEqual(kvsCalls, [
    { KvsARN: 'arn:aws:cloudfront::355600359887:key-value-store/abc', MaxResults: KVS_PAGE, NextToken: undefined },
    { KvsARN: 'arn:aws:cloudfront::355600359887:key-value-store/abc', MaxResults: KVS_PAGE, NextToken: 't1' },
  ])
  // emcog-org.com is emcog-org-com, not emcog-org.
  assert.deepEqual([...map], [['/about', '/who'], ['/Board%20Minutes.html', '/meetings']])
})

test('the redirect store is read with SigV4A, which the SDK can sign without the native CRT', async () => {
  const { CloudFrontKeyValueStoreClient } = await import('@aws-sdk/client-cloudfront-keyvaluestore')
  const rec = recordingHandler(() => ({ body: '{"Items":[]}' }))
  const kvs = new CloudFrontKeyValueStoreClient({ region: 'us-east-1', credentials: fakeCredentials, requestHandler: rec.handler })
  const store = awsStore({ s3: {}, cloudfront: { send: async () => ({ KeyValueStore: { ARN: 'arn:aws:cloudfront::355600359887:key-value-store/abc' } }) }, kvs })
  assert.deepEqual([...(await store.redirects(GOVERNMENT_REDIRECT_STORE, site))], [])
  assert.match(rec.requests[0].headers.authorization, /^AWS4-ECDSA-P256-SHA256 /)
  assert.equal(rec.requests[0].hostname, '355600359887.cloudfront-kvs.global.api.aws')
})

// --- The workflows ---

const workflow = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
const ACCOUNT_INPUT = /\n      account:\n        description: .+\n        type: string\n        default: live\n/

test('deploy-preview.yml: an optional account (default live), checked before any AWS call, passed to the script', () => {
  const wf = workflow('deploy-preview.yml')
  assert.match(wf, ACCOUNT_INPUT)
  const build = wf.slice(wf.indexOf('\n  build:'), wf.indexOf('\n  deploy:'))
  const deploy = wf.slice(wf.indexOf('\n  deploy:'), wf.indexOf('\n  notify:'))
  for (const job of [build, deploy]) {
    const check = job.indexOf('- name: Check the account')
    assert.ok(check > 0)
    assert.match(job.slice(check), /\[\[ "\$ACCOUNT" = live \|\| "\$ACCOUNT" = government \]\] \|\| \{ echo "::error::account must be live or government"; exit 1; \}/)
  }
  assert.ok(deploy.indexOf('- name: Check the account') < deploy.indexOf('configure-aws-credentials'))
  // The preview role is the preview account's whatever the account: a government site's preview is still a preview.
  assert.match(deploy, /role-to-assume: arn:aws:iam::798070830797:role\/coderizehq-preview-deploy-\$\{\{ inputs\.site \}\}\n/)
  assert.match(deploy.slice(deploy.indexOf('- name: Store the build and publish the preview')), /ACCOUNT: \$\{\{ inputs\.account \}\}/)
})

test('release.yml: an optional account (default live), mapped to the publish role account, checked before any AWS call', () => {
  const wf = workflow('release.yml')
  assert.match(wf, ACCOUNT_INPUT)
  const verify = wf.slice(wf.indexOf('\n  verify:'), wf.indexOf('\n  publish:'))
  assert.match(verify, /- name: Check the account\n/)
  const publish = wf.slice(wf.indexOf('\n  publish:'), wf.indexOf('\n  notify:'))
  const pick = publish.slice(publish.indexOf('- name: Pick the account'), publish.indexOf('configure-aws-credentials'))
  assert.ok(pick.length > 0, 'the account is picked before the credentials')
  // The workflow's map is lib/build.mjs's, so the role ARN for live is the one it always was.
  const map = Object.fromEntries([...pick.matchAll(/^\s+(\w+)\) id=(\d{12}) ;;$/gm)].map((m) => [m[1], m[2]]))
  assert.deepEqual(map, Object.fromEntries(Object.entries(ACCOUNTS).map(([name, a]) => [name, a.id])))
  assert.match(pick, /\*\) echo "::error::account must be live or government"; exit 1 ;;/)
  assert.match(publish, /role-to-assume: arn:aws:iam::\$\{\{ steps\.account\.outputs\.id \}\}:role\/coderizehq-live-publish-\$\{\{ inputs\.site \}\}\n/)
  assert.equal(`arn:aws:iam::${map.live}:role/coderizehq-live-publish-sbmcdn-com`, liveRoleArn('sbmcdn-com'))
  assert.equal(`arn:aws:iam::${map.government}:role/coderizehq-live-publish-${site}`, liveRoleArn(site, 'government'))
  assert.match(publish.slice(publish.indexOf('- name: Publish to live')), /ACCOUNT: \$\{\{ inputs\.account \}\}/)
  // Notifications stay in the live account for every site (SES there).
  assert.match(wf.slice(wf.indexOf('\n  notify:')), /role-to-assume: arn:aws:iam::243891826043:role\/coderizehq-notify-send\n/)
  assert.doesNotMatch(wf, /role-to-assume: arn:aws:iam::243891826043:role\/coderizehq-live-publish/, 'no hard-coded live account on the publish role')
})

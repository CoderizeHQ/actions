// A dry run of deploy-preview's storing and publishing against a temp build folder and an in-memory S3.

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { publishPreview, storeBuild } from './deployPreview.mjs'
import { manifestKey, PREVIEW_BUCKET, PREVIEW_DISTRIBUTION, storedKey } from './lib/build.mjs'
import { CACHE_IMMUTABLE } from './lib/files.mjs'
import { memoryStore } from './lib/memoryStore.mjs'

const site = 'sbmcdn-com'
const repo = 'CoderizeHQ/gate-test-web'
const commit = '1'.repeat(40)
const common = { site, repo, commit, workflowSha: '2'.repeat(40), lockfileSha256: '3'.repeat(64), log: () => {} }

async function build(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'build-'))
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await writeFile(path.join(dir, name), body)
  }
  return dir
}

const site1 = {
  'index.html': '<h1>home</h1>',
  'about/index.html': '<h1>about</h1>',
  '_astro/app.DQ3k2zL8.js': 'console.log(1)',
  'manifest.json': '{"name":"web app manifest"}',
}

test('stores the build write-once with its manifest last, then publishes it', async () => {
  const store = memoryStore()
  const buildDir = await build(site1)
  const stored = await storeBuild({ store, buildDir, ...common })
  assert.equal(stored.reused, false)
  assert.equal(stored.files.length, 4)

  const puts = store.calls.filter((c) => c[0] === 'put').map((c) => c[2])
  assert.equal(puts.at(-1), manifestKey(site, commit), 'manifest written last')
  const manifest = JSON.parse((await store.get(PREVIEW_BUCKET, manifestKey(site, commit))).body)
  assert.equal(manifest.version, 1)
  assert.equal(manifest.workflow_sha, '2'.repeat(40))
  assert.equal(manifest.lockfile_sha256, '3'.repeat(64))
  assert.ok(manifest.files['manifest.json'], "a site's own manifest.json doesn't collide with the build manifest")
  assert.equal(store.buckets.get(PREVIEW_BUCKET).get(storedKey(site, commit, '_astro/app.DQ3k2zL8.js')).cacheControl, CACHE_IMMUTABLE)

  const result = await publishPreview({ store, site, commit, files: stored.files, log: () => {} })
  assert.deepEqual({ ...result, invalidation: Boolean(result.invalidation) }, { copies: 4, deletes: 0, unchanged: 0, invalidation: true })
  assert.deepEqual(store.invalidations, [{ distributionId: PREVIEW_DISTRIBUTION, paths: ['/sites/sbmcdn-com/*'] }])
  assert.ok(store.calls.some((c) => c[0] === 'waitInvalidation'), 'waits for the cache clear')
  const preview = await store.list(PREVIEW_BUCKET, `sites/${site}/`)
  assert.deepEqual(preview.map((o) => o.key).sort(), Object.keys(site1).sort())
  await rm(buildDir, { recursive: true })
})

test('a second run for the same commit reuses the stored build and changes nothing', async () => {
  const store = memoryStore()
  const first = await storeBuild({ store, buildDir: await build(site1), ...common })
  await publishPreview({ store, site, commit, files: first.files, log: () => {} })

  // A rebuild that came out different is ignored: the stored build is what release will publish.
  const again = await storeBuild({ store, buildDir: await build({ ...site1, 'index.html': 'different' }), ...common })
  assert.equal(again.reused, true)
  assert.equal(again.manifestSha256, first.manifestSha256)
  const result = await publishPreview({ store, site, commit, files: again.files, log: () => {} })
  assert.deepEqual(result, { copies: 0, deletes: 0, unchanged: 4, invalidation: null })
  assert.equal(store.invalidations.length, 1, 'cache cleared only by the first run')
})

test('a partial earlier run is completed when the files match, and refused when they differ', async () => {
  const store = memoryStore()
  store.seed(PREVIEW_BUCKET, storedKey(site, commit, 'index.html'), '<h1>home</h1>')
  const stored = await storeBuild({ store, buildDir: await build(site1), ...common })
  assert.equal(stored.files.length, 4)

  const other = memoryStore()
  other.seed(PREVIEW_BUCKET, storedKey(site, commit, 'index.html'), 'something else')
  await assert.rejects(storeBuild({ store: other, buildDir: await build(site1), ...common }), /different content/)
  assert.equal(await other.get(PREVIEW_BUCKET, manifestKey(site, commit)), null, 'no manifest for a mixed build')
})

test('a stored file that no longer matches its manifest stops the deploy', async () => {
  const store = memoryStore()
  await storeBuild({ store, buildDir: await build(site1), ...common })
  store.seed(PREVIEW_BUCKET, storedKey(site, commit, 'about/index.html'), 'tampered')
  await assert.rejects(storeBuild({ store, buildDir: await build(site1), ...common }), /about\/index.html/)
})

test('publishing deletes only inside the site folder, and refuses a mass delete', async () => {
  const store = memoryStore()
  for (let i = 0; i < 40; i++) store.seed(PREVIEW_BUCKET, `sites/${site}/old-${i}.html`, `old ${i}`)
  store.seed(PREVIEW_BUCKET, 'sites/other-com/index.html', 'another site')
  const stored = await storeBuild({ store, buildDir: await build(site1), ...common })

  await assert.rejects(publishPreview({ store, site, commit, files: stored.files, log: () => {} }), /would delete 40 of 40/)
  assert.equal(store.calls.filter((c) => c[0] === 'copy').length, 0, 'nothing copied before the guard')

  const result = await publishPreview({ store, site, commit, files: stored.files, maxShare: 1, log: () => {} })
  assert.equal(result.deletes, 40)
  assert.ok(await store.get(PREVIEW_BUCKET, 'sites/other-com/index.html'), "another site's preview is untouched")
})

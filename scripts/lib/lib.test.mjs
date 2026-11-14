import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { DELETE_FLOOR, deleteGuard, liveRoleArn, makeManifest, planSync, previewRoleArn, readManifest, storedKey } from './build.mjs'
import { CACHE_IMMUTABLE, CACHE_SHORT, cacheControlFor, checkPath, contentTypeFor, walkBuild } from './files.mjs'
import { checkClaims, decodeClaims } from './oidc.mjs'

const SHA = 'a'.repeat(40)

test('hashed bundles are cached for a year, everything else for 5 minutes', () => {
  assert.equal(cacheControlFor('_astro/index.DQ3k2zL8.js'), CACHE_IMMUTABLE)
  assert.equal(cacheControlFor('_astro/hero.Ab12Cd34_Z1abcd.webp'), CACHE_IMMUTABLE)
  assert.equal(cacheControlFor('assets/index-BcDeFgH1.css'), CACHE_IMMUTABLE)
  assert.equal(cacheControlFor('index.html'), CACHE_SHORT)
  assert.equal(cacheControlFor('_astro/page.html'), CACHE_SHORT)
  assert.equal(cacheControlFor('robots.txt'), CACHE_SHORT)
  assert.equal(cacheControlFor('logo.png'), CACHE_SHORT)
  assert.equal(cacheControlFor('images/photo.DQ3k2zL8.jpg'), CACHE_SHORT)
})

test('content types follow the extension', () => {
  assert.equal(contentTypeFor('a/b/index.html'), 'text/html; charset=utf-8')
  assert.equal(contentTypeFor('sitemap-index.xml'), 'application/xml; charset=utf-8')
  assert.equal(contentTypeFor('x.WOFF2'), 'font/woff2')
  assert.equal(contentTypeFor('LICENSE'), 'application/octet-stream')
})

test('role ARNs come from the site name, and a bad site name is refused', () => {
  assert.equal(previewRoleArn('sbmcdn-com'), 'arn:aws:iam::798070830797:role/coderizehq-preview-deploy-sbmcdn-com')
  assert.equal(liveRoleArn('sbmcdn-com'), 'arn:aws:iam::243891826043:role/coderizehq-live-publish-sbmcdn-com')
  assert.throws(() => previewRoleArn('sbmcdn.com'))
  assert.throws(() => previewRoleArn('../x'))
  assert.throws(() => previewRoleArn('a'.repeat(39)), 'longer than IAM role names allow')
  assert.ok(previewRoleArn('a'.repeat(38)).length <= 64 + 'arn:aws:iam::798070830797:role/'.length)
  assert.throws(() => storedKey('sbmcdn-com', 'HEAD', 'index.html'))
})

test('unsafe build paths are refused', () => {
  for (const p of ['/etc/passwd', 'a/../b', 'a//b', './a', 'a\\b', 'a\nb']) assert.throws(() => checkPath(p), p)
  checkPath('a/b c/d.html')
})

test('walkBuild lists files sorted with hashes, and refuses symlinks', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'walk-'))
  await mkdir(path.join(dir, 'about'))
  await writeFile(path.join(dir, 'index.html'), 'home')
  await writeFile(path.join(dir, 'about', 'index.html'), 'about')
  const files = await walkBuild(dir)
  assert.deepEqual(files.map((f) => f.path), ['about/index.html', 'index.html'])
  assert.equal(files[1].sha256, '4ea140588150773ce3aace786aeef7f4049ce100fa649c94fbbddb960f1da942')
  assert.equal(files[1].size, 4)

  try {
    await symlink(path.join(dir, 'index.html'), path.join(dir, 'link.html'))
  } catch {
    t.diagnostic('symlinks unavailable here; skipped that part')
    return
  }
  await assert.rejects(walkBuild(dir), /symlink/)
})

test('an empty build is refused', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'empty-'))
  await assert.rejects(walkBuild(dir), /no files/)
})

test('a manifest round-trips, and one for another site, repo or commit is refused', () => {
  const m = makeManifest({
    site: 'sbmcdn-com',
    repo: 'CoderizeHQ/gate-test-web',
    commit: SHA,
    workflowSha: 'b'.repeat(40),
    lockfileSha256: 'c'.repeat(64),
    created: '2026-11-14T00:00:00.000Z',
    files: [{ path: 'index.html', size: 4, sha256: 'd'.repeat(64), md5: 'x' }],
  })
  assert.deepEqual(m.files, { 'index.html': { size: 4, sha256: 'd'.repeat(64) } })
  const who = { site: 'sbmcdn-com', repo: 'CoderizeHQ/gate-test-web', commit: SHA }
  assert.deepEqual(readManifest(m, who), [{ path: 'index.html', size: 4, sha256: 'd'.repeat(64) }])
  assert.throws(() => readManifest(m, { ...who, site: 'other-com' }), /site/)
  assert.throws(() => readManifest(m, { ...who, repo: 'CoderizeHQ/x' }), /repo/)
  assert.throws(() => readManifest(m, { ...who, commit: 'e'.repeat(40) }), /commit/)
  assert.throws(() => readManifest({ ...m, files: {} }, who), /no files/)
})

test('planSync copies new and changed files and deletes the rest', () => {
  const plan = planSync(
    [
      { path: 'index.html', etag: 'new' },
      { path: 'about/index.html', etag: 'same' },
      { path: 'contact/index.html', etag: 'c' },
    ],
    [
      { key: 'index.html', etag: 'old' },
      { key: 'about/index.html', etag: 'same' },
      { key: 'gone.html', etag: 'g' },
    ],
  )
  assert.deepEqual(plan, { copies: ['index.html', 'contact/index.html'], deletes: ['gone.html'], unchanged: 1 })
})

test('the mass-delete guard allows small deletions and refuses large shares', () => {
  assert.equal(deleteGuard({ current: 12, deletes: DELETE_FLOOR }), null)
  assert.equal(deleteGuard({ current: 400, deletes: 100 }), null)
  assert.match(deleteGuard({ current: 400, deletes: 101 }), /would delete 101 of 400/)
  assert.match(deleteGuard({ current: 40, deletes: 39 }), /refusing/)
  assert.equal(deleteGuard({ current: 40, deletes: 39, maxShare: 1 }), null)
  assert.match(deleteGuard({ current: 40, deletes: 1, maxShare: 2 }), /between 0 and 1/)
})

test('OIDC claims must name this workflow, its commit, the repo and the commit', () => {
  const claims = {
    job_workflow_ref: 'CoderizeHQ/actions/.github/workflows/deploy-preview.yml@refs/tags/v1',
    job_workflow_sha: 'b'.repeat(40),
    repository: 'CoderizeHQ/gate-test-web',
    sha: SHA,
  }
  const jwt = `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`
  assert.deepEqual(decodeClaims(jwt), claims)
  const want = { workflow: 'deploy-preview.yml', workflowSha: 'b'.repeat(40), repo: 'CoderizeHQ/gate-test-web', commit: SHA }
  assert.deepEqual(checkClaims(claims, want), [])
  assert.equal(checkClaims(claims, { ...want, workflow: 'release.yml' }).length, 1)
  assert.equal(checkClaims({ ...claims, job_workflow_sha: 'f'.repeat(40) }, want).length, 1)
  assert.equal(checkClaims({ ...claims, job_workflow_ref: 'evil/actions/.github/workflows/deploy-preview.yml@v1' }, want).length, 1)
})

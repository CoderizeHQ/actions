import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decide, JAMES_ID, RENOVATE_ID } from './reviewStub.mjs'

const BOT_ID = 356656124 // coderizehq-bot

const pr = (over = {}) => ({
  repo: 'gate-test-web',
  authorId: BOT_ID,
  headRef: 'feature/x',
  headSha: 'head',
  files: ['src/pages/index.astro'],
  commitAuthorIds: [BOT_ID],
  reviews: [],
  ...over,
})

test('an ordinary site PR passes', () => {
  assert.equal(decide(pr()).conclusion, 'success')
})

test('a PR touching a code-owned path waits for James', () => {
  for (const f of ['package.json', '.github/workflows/ci.yml', 'renovate.json', 'CLAUDE.md', 'patches/x.patch']) {
    assert.equal(decide(pr({ files: [f] })).status, 'in_progress', f)
  }
})

test("James's approval at the head commit passes a risky PR", () => {
  const reviews = [{ userId: JAMES_ID, state: 'APPROVED', commitId: 'head' }]
  assert.equal(decide(pr({ files: ['package.json'], reviews })).conclusion, 'success')
})

test('an approval on an older commit does not count', () => {
  const reviews = [{ userId: JAMES_ID, state: 'APPROVED', commitId: 'older' }]
  assert.equal(decide(pr({ files: ['package.json'], reviews })).status, 'in_progress')
})

test("someone else's approval does not count", () => {
  const reviews = [{ userId: BOT_ID, state: 'APPROVED', commitId: 'head' }]
  assert.equal(decide(pr({ files: ['package.json'], reviews })).status, 'in_progress')
})

test("James's later request for changes at the head undoes his approval", () => {
  const reviews = [
    { userId: JAMES_ID, state: 'APPROVED', commitId: 'head' },
    { userId: JAMES_ID, state: 'CHANGES_REQUESTED', commitId: 'head' },
  ]
  assert.equal(decide(pr({ files: ['package.json'], reviews })).status, 'in_progress')
})

test('every release PR waits for James', () => {
  assert.equal(decide(pr({ headRef: 'release-please--branches--main', files: ['CHANGELOG.md'] })).status, 'in_progress')
  assert.equal(decide(pr({ headRef: 'release-please--branches--main', files: ['src/x.astro'] })).status, 'in_progress')
})

test('every PR in a protected repo waits for James', () => {
  assert.equal(decide(pr({ repo: 'platform' })).status, 'in_progress')
  assert.equal(decide(pr({ repo: 'site-template' })).conclusion, 'success')
})

test("Renovate's own lockfile-only update is skipped", () => {
  const renovate = { authorId: RENOVATE_ID, headRef: 'renovate/astro', files: ['pnpm-lock.yaml'], commitAuthorIds: [RENOVATE_ID] }
  assert.equal(decide(pr(renovate)).conclusion, 'skipped')
})

test('a lockfile-only PR with a non-Renovate commit or author is not skipped', () => {
  const base = { headRef: 'renovate/astro', files: ['pnpm-lock.yaml'] }
  assert.notEqual(decide(pr({ ...base, authorId: RENOVATE_ID, commitAuthorIds: [RENOVATE_ID, BOT_ID] })).conclusion, 'skipped')
  assert.notEqual(decide(pr({ ...base, authorId: BOT_ID, commitAuthorIds: [RENOVATE_ID] })).conclusion, 'skipped')
  assert.notEqual(decide(pr({ ...base, authorId: RENOVATE_ID, commitAuthorIds: [null] })).conclusion, 'skipped')
})

test('a Renovate PR that changes package.json waits for James', () => {
  const renovate = { authorId: RENOVATE_ID, headRef: 'renovate/astro', files: ['package.json', 'pnpm-lock.yaml'], commitAuthorIds: [RENOVATE_ID] }
  assert.equal(decide(pr(renovate)).status, 'in_progress')
})

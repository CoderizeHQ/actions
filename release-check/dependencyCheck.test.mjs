import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decideDependencyRun, isMinorOrPatch, lockfileChanges, RENOVATE_ID } from './dependencyCheck.mjs'

const lockPatch = [
  '@@ -100,7 +100,7 @@ packages:',
  "-  '@astrojs/sitemap@3.7.3':",
  "+  '@astrojs/sitemap@3.7.4':",
  '-    resolution: {integrity: sha512-old}',
  '+    resolution: {integrity: sha512-new}',
  '-  astro@7.2.9(@types/node@24.1.0):',
  '+  astro@7.3.0(@types/node@24.1.0):',
  '   zod@4.1.0:',
].join('\n')

const pr = (over = {}) => ({
  number: 7,
  merged: true,
  mergeSha: 'c1',
  baseRef: 'main',
  authorId: RENOVATE_ID,
  headRef: 'renovate/astro-monorepo',
  files: [{ name: 'pnpm-lock.yaml', status: 'modified', patch: lockPatch }],
  commits: [{ authorId: RENOVATE_ID, verified: true }],
  checks: [
    { name: 'ci / ci-site', status: 'completed', conclusion: 'success' },
    { name: 'review', status: 'completed', conclusion: 'skipped' },
  ],
  statusState: 'pending',
  statusCount: 0,
  ...over,
})

const facts = (over = {}) => ({
  base: { sha: 'b0', tag: 'v1.2.0' },
  head: 'c1',
  compareStatus: 'ahead',
  commits: [{ sha: 'c1', pr: pr() }],
  ...over,
})

test('minor and patch updates pass; majors, 0.x minors and odd versions do not', () => {
  assert.equal(isMinorOrPatch('1.2.3', '1.2.4'), true)
  assert.equal(isMinorOrPatch('1.2.3', '1.9.0'), true)
  assert.equal(isMinorOrPatch('1.2.3', '2.0.0'), false)
  assert.equal(isMinorOrPatch('0.4.1', '0.4.9'), true)
  assert.equal(isMinorOrPatch('0.4.1', '0.5.0'), false)
  assert.equal(isMinorOrPatch('1.2.3', '1.3.0-beta.1'), false)
})

test('the lockfile diff is read for version moves', () => {
  const { problems, bumps } = lockfileChanges(lockPatch)
  assert.deepEqual(problems, [])
  assert.deepEqual(bumps.map((b) => `${b.name} ${b.to}`), ['@astrojs/sitemap 3.7.4', 'astro 7.3.0'])
})

test('a major bump, a non-registry source or a missing diff is a problem', () => {
  assert.match(lockfileChanges('-  astro@7.2.9:\n+  astro@8.0.0:').problems[0], /not a minor or patch/)
  assert.match(lockfileChanges('+  evil@1.0.0:\n+    resolution: {tarball: https://evil.example/e.tgz}').problems[0], /not from the npm registry/)
  assert.match(lockfileChanges(undefined).problems[0], /too large/)
  assert.deepEqual(lockfileChanges('+  brand-new@1.0.0:\n+    resolution: {integrity: sha512-x}').problems, [], 'a new transitive package is fine')
})

test('a gap of passing Renovate lockfile PRs is released', () => {
  assert.deepEqual(decideDependencyRun(facts()), { ok: true, nothing: false, reasons: [], prs: [7] })
})

test('nothing since the last release publishes nothing', () => {
  assert.deepEqual(decideDependencyRun(facts({ compareStatus: 'identical', commits: [] })), { ok: true, nothing: true, reasons: [], prs: [] })
})

test('with no earlier version release, or main not ahead of it, the run is refused', () => {
  assert.equal(decideDependencyRun(facts({ base: null })).ok, false)
  assert.equal(decideDependencyRun(facts({ compareStatus: 'diverged' })).ok, false)
})

test('one non-Renovate commit in the gap leaves the release for James', () => {
  const r = decideDependencyRun(facts({ commits: [{ sha: 'c0', pr: pr({ mergeSha: 'c0' }) }, { sha: 'c1', pr: pr({ number: 8, authorId: 74272118 }) }] }))
  assert.equal(r.ok, false)
  assert.match(r.reasons.join(' '), /#8 was not opened by Renovate/)
})

test('a direct push, another branch, extra files, unverified commits or a failed check are each refused', () => {
  const refuse = (over, re) => {
    const r = decideDependencyRun(facts({ commits: [{ sha: 'c1', pr: over === null ? null : pr(over) }] }))
    assert.equal(r.ok, false)
    assert.match(r.reasons.join(' '), re)
  }
  refuse(null, /not the merge of a pull request/)
  refuse({ headRef: 'feature/sneaky' }, /renovate\/ branch/)
  refuse({ files: [...pr().files, { name: 'package.json', status: 'modified', patch: '' }] }, /more than pnpm-lock/)
  refuse({ commits: [{ authorId: RENOVATE_ID, verified: false }] }, /verified/)
  refuse({ commits: [{ authorId: RENOVATE_ID, verified: true }, { authorId: 1, verified: true }] }, /verified/)
  refuse({ checks: [{ name: 'ci / ci-site', status: 'completed', conclusion: 'failure' }] }, /ci-site is failure/)
  refuse({ checks: [{ name: 'ci / ci-site', status: 'in_progress', conclusion: null }] }, /in_progress/)
  refuse({ checks: [] }, /no checks/)
  refuse({ statusCount: 1, statusState: 'failure' }, /commit status/)
  refuse({ baseRef: 'develop' }, /not merged into main/)
  refuse({ files: [{ name: 'pnpm-lock.yaml', status: 'modified', patch: '-  astro@7.2.9:\n+  astro@8.0.0:' }] }, /not a minor or patch/)
})

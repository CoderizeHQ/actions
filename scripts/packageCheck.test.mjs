import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { checkPackages, floatingReason, floatingSpecifiers, otherLockfiles } from './packageCheck.mjs'

test('real ranges and local protocols pass', () => {
  for (const spec of ['^7.1.3', '~1.2.0', '1.2.3', '>=1.0.0 <2', '1.x', '^1 || ^2', 'workspace:*', 'catalog:', 'link:../x', 'file:./vendor/x.tgz', 'npm:strip-ansi@^6.0.1']) {
    assert.equal(floatingReason(spec), null, spec)
  }
})

test('dist-tags, wildcards, empty versions and non-registry sources float', () => {
  assert.match(floatingReason('latest'), /dist-tag/)
  assert.match(floatingReason('next'), /dist-tag/)
  assert.match(floatingReason('*'), /any version/)
  assert.match(floatingReason('x'), /any version/)
  assert.match(floatingReason('X.x'), /any version/)
  assert.match(floatingReason(''), /empty/)
  assert.match(floatingReason('npm:strip-ansi@latest'), /dist-tag/)
  assert.match(floatingReason('github:owner/repo'), /not a version from the npm registry/)
  assert.match(floatingReason('owner/repo#main'), /not a version from the npm registry/)
  assert.match(floatingReason('git+https://github.com/o/r.git'), /not a version from the npm registry/)
  assert.match(floatingReason('https://example.com/x.tgz'), /not a version from the npm registry/)
})

test('every dependency field is checked, peer dependencies are not', () => {
  const pkg = { dependencies: { a: '^1.0.0', b: 'latest' }, devDependencies: { c: '*' }, optionalDependencies: { d: '' }, peerDependencies: { e: '*' } }
  const problems = floatingSpecifiers(pkg, 'package.json')
  assert.equal(problems.length, 3)
  assert.match(problems[0], /dependencies\.b/)
})

test('a second lockfile anywhere fails', () => {
  assert.deepEqual(otherLockfiles(['pnpm-lock.yaml', 'package.json']), [])
  assert.equal(otherLockfiles(['package-lock.json', 'apps/web/yarn.lock', 'npm-shrinkwrap.json']).length, 3)
})

test('the repo check reads every tracked package.json', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pkg-'))
  await mkdir(path.join(dir, 'apps', 'web'), { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { prettier: '^3.6.0' } }))
  await writeFile(path.join(dir, 'apps', 'web', 'package.json'), JSON.stringify({ dependencies: { astro: 'latest' } }))
  await writeFile(path.join(dir, 'broken.json'), '{')
  const problems = checkPackages(dir, ['package.json', 'apps/web/package.json', 'yarn.lock'])
  assert.equal(problems.length, 2)
  assert.match(problems.join('\n'), /yarn\.lock/)
  assert.match(problems.join('\n'), /apps\/web\/package\.json: dependencies\.astro/)
})

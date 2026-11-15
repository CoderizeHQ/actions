import assert from 'node:assert/strict'
import { test } from 'node:test'

import { entryProblems, lockfilePackages, npmrcProblems, parseKey, registryProblems, versionUrl } from './lockfileCheck.mjs'

// The shape pnpm 12 writes: one YAML document for pnpm itself, then the project's.
const LOCKFILE = `---
lockfileVersion: '9.0'

importers:

  .:
    packageManagerDependencies:
      pnpm:
        specifier: 12.15.0
        version: 12.15.0

packages:

  pnpm@12.15.0:
    resolution: {integrity: sha512-aaaa}
    hasBin: true

snapshots:

  pnpm@12.15.0: {}

---
lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      astro:
        specifier: ^7.0.0
        version: 7.0.1

packages:

  '@scope/name@1.2.3':
    resolution: {integrity: sha512-bbbb==}
    engines: {node: '>=18'}

  astro@7.0.1:
    resolution: {integrity: sha512-cccc, tarball: https://registry.npmjs.org/astro/-/astro-7.0.1.tgz}

  evil@1.0.0:
    resolution: {integrity: sha512-dddd, tarball: https://cache.example.com/evil-1.0.0.tgz}

  fromgit@1.0.0:
    resolution: {commit: 0123abc, repo: https://github.com/o/r.git, type: git}

  local@0.0.1:
    resolution: {directory: packages/local, type: directory}

  weak@1.0.0:
    resolution: {integrity: sha1-eeee}

  bare@1.0.0:
    engines: {node: '>=18'}
`

test('reads the packages of both documents, and nothing from snapshots or importers', () => {
  const entries = lockfilePackages(LOCKFILE)
  assert.deepEqual(entries.map((e) => e.key), ['pnpm@12.15.0', "'@scope/name@1.2.3'", 'astro@7.0.1', 'evil@1.0.0', 'fromgit@1.0.0', 'local@0.0.1', 'weak@1.0.0', 'bare@1.0.0'])
  assert.deepEqual(entries[1].resolution, { integrity: 'sha512-bbbb==' })
  assert.deepEqual(parseKey("'@scope/name@1.2.3'"), { name: '@scope/name', version: '1.2.3' })
})

test('only registry packages with a sha512 checksum pass', () => {
  const problems = entryProblems(lockfilePackages(LOCKFILE))
  assert.equal(problems.length, 5)
  assert.match(problems[0], /evil@1\.0\.0 downloads from https:\/\/cache\.example\.com/)
  assert.match(problems[1], /fromgit@1\.0\.0 is not from the npm registry/)
  assert.match(problems[2], /local@0\.0\.1 is not from the npm registry/)
  assert.match(problems[3], /weak@1\.0\.0 has no sha512/)
  assert.match(problems[4], /bare@1\.0\.0 has no resolution/)
})

test('.npmrc may not send any scope to another registry', () => {
  assert.deepEqual(npmrcProblems('registry=https://registry.npmjs.org/\nauto-install-peers=true\n'), [])
  assert.deepEqual(npmrcProblems('registry=https://registry.npmjs.org'), [])
  assert.equal(npmrcProblems('@acme:registry=https://npm.acme.dev/\nregistry = http://registry.npmjs.org/').length, 2)
})

test('the registry check compares each checksum with the one the registry publishes', async () => {
  const published = { 'https://registry.npmjs.org/@scope%2Fname/1.2.3': 'sha512-bbbb==', 'https://registry.npmjs.org/astro/7.0.1': 'sha512-other' }
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.endsWith('/gone/1.0.0')) return { status: 404, ok: false }
    return { status: 200, ok: true, json: async () => ({ dist: { integrity: published[url] } }) }
  }
  const entries = [
    { key: "'@scope/name@1.2.3'", name: '@scope/name', version: '1.2.3', resolution: { integrity: 'sha512-bbbb==' } },
    { key: 'astro@7.0.1', name: 'astro', version: '7.0.1', resolution: { integrity: 'sha512-cccc' } },
    { key: 'gone@1.0.0', name: 'gone', version: '1.0.0', resolution: { integrity: 'sha512-ffff' } },
  ]
  const problems = await registryProblems(entries, fetchImpl)
  assert.equal(calls.length, 3)
  assert.equal(problems.length, 2)
  assert.match(problems[0], /astro@7\.0\.1: the lockfile's checksum is not the one the npm registry publishes \(sha512-other\)/)
  assert.match(problems[1], /gone@1\.0\.0 is not on the npm registry/)
  assert.equal(versionUrl('@a/b', '1.0.0+build'), 'https://registry.npmjs.org/@a%2Fb/1.0.0%2Bbuild')
})

test('a registry outage is retried, then stops the check rather than passing it', async () => {
  let calls = 0
  const down = async () => {
    calls++
    return { status: 503, ok: false }
  }
  await assert.rejects(registryProblems([{ key: 'a@1.0.0', name: 'a', version: '1.0.0', resolution: { integrity: 'sha512-x' } }], down), /503/)
  assert.equal(calls, 3)
})

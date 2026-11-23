import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  entryProblems,
  isPlainRelativeDir,
  isWorkspacePackage,
  lockfileImporters,
  lockfilePackages,
  npmrcProblems,
  parseKey,
  registryProblems,
  versionUrl,
  workspacePackages,
} from './lockfileCheck.mjs'

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

// What pnpm writes when injectWorkspacePackages can't deduplicate an injected copy back to a link
// (trafficticketbuddy-com-mono: the API's devDependency on its portal, once their peers resolved differently).
const INJECTED = `---
lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      turbo:
        specifier: ^2.10.12
        version: 2.11.11

  apps/api:
    devDependencies:
      '@acme/portal':
        specifier: workspace:*
        version: file:apps/portal(react@19.3.1)

  apps/portal:
    dependencies:
      '@acme/ui':
        specifier: workspace:*
        version: link:../../packages/ui

  packages/ui: {}

packages:

  '@acme/portal@file:apps/portal':
    resolution: {directory: apps/portal, type: directory}
    engines: {node: '>=26'}

  '@acme/ui@file:packages/ui':
    resolution: {directory: packages/ui, type: directory}

  turbo@2.11.11:
    resolution: {integrity: sha512-tttt}

snapshots:

  '@acme/portal@file:apps/portal(react@19.3.1)':
    dependencies:
      '@acme/ui': file:packages/ui
`

test('reads the importer folders, apart from the root', () => {
  assert.deepEqual(lockfileImporters(INJECTED), ['apps/api', 'apps/portal', 'packages/ui'])
  assert.deepEqual(lockfileImporters(LOCKFILE), [])
})

test('only plain relative folders count', () => {
  for (const ok of ['apps/portal', 'packages/ui', 'a']) assert.equal(isPlainRelativeDir(ok), true, ok)
  for (const bad of ['', '.', '..', '../x', 'apps/../..', './apps', '/etc', 'C:/x', 'apps\\x', 'apps//x', 'apps/'])
    assert.equal(isPlainRelativeDir(bad), false, bad)
})

test('an injected workspace package passes; any other folder still fails', () => {
  const workspace = new Map([
    ['apps/api', '@acme/api'],
    ['apps/portal', '@acme/portal'],
    ['packages/ui', '@acme/ui'],
  ])
  const entries = lockfilePackages(INJECTED)
  assert.deepEqual(entryProblems(entries, workspace), [])
  assert.deepEqual(entries.filter((e) => !isWorkspacePackage(e, workspace)).map((e) => e.key), ['turbo@2.11.11'], 'only registry packages go to the registry')

  // Without the workspace (or before this change), they're folders like any other.
  assert.equal(entryProblems(entries).length, 2)
  // A name that isn't the folder's package.json name.
  assert.match(entryProblems(entries, new Map([['apps/portal', '@acme/other'], ['packages/ui', '@acme/ui']]))[0], /@acme\/portal@file:apps\/portal' is not from the npm registry/)
  const one = (key, resolution) => entryProblems([{ key, ...parseKey(key), resolution }], workspace)
  // A folder that isn't an importer, a key that names another folder, or anything beyond directory and type.
  assert.equal(one('@acme/portal@file:vendor/portal', { directory: 'vendor/portal', type: 'directory' }).length, 1)
  assert.equal(one('@acme/portal@file:apps/portal', { directory: 'packages/ui', type: 'directory' }).length, 1)
  assert.equal(one('@acme/portal@file:apps/portal', { directory: 'apps/portal', type: 'directory', integrity: 'sha512-x' }).length, 1)
  assert.equal(one('@acme/portal@1.0.0', { directory: 'apps/portal', type: 'directory' }).length, 1)
  assert.equal(one('@acme/portal@file:apps/portal', { tarball: 'file:apps/portal.tgz', type: 'directory', directory: 'apps/portal' }).length, 1)
})

test('workspace packages are read from folders inside the checkout only', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'lockfile-check-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const repo = path.join(base, 'repo')
  const pkg = async (dir, json) => {
    await mkdir(dir, { recursive: true })
    if (json !== undefined) await writeFile(path.join(dir, 'package.json'), json)
  }
  await pkg(path.join(repo, 'apps/portal'), JSON.stringify({ name: '@acme/portal' }))
  await pkg(path.join(repo, 'apps/broken'), '{ not json')
  await pkg(path.join(repo, 'apps/empty'))
  await pkg(path.join(base, 'outside'), JSON.stringify({ name: '@acme/outside' }))
  // A folder in the repo that is a link to one outside it.
  await symlink(path.join(base, 'outside'), path.join(repo, 'apps/linked'), 'junction')

  const found = await workspacePackages(repo, ['apps/portal', 'apps/broken', 'apps/empty', 'apps/missing', 'apps/linked', '../outside', '.'])
  assert.deepEqual([...found], [['apps/portal', '@acme/portal']])
})

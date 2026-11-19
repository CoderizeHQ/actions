import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkApp, checkCommit, checkWorkspace, pushImage, REGISTRY } from './appImage.mjs'

const good = `packages:
  - apps/*
injectWorkspacePackages: true
supportedArchitectures:
  os: [current, linux]
  cpu: [current, arm64]
  libc: [current, glibc]
`

test('checkApp and checkCommit refuse what would break a role name, a repository or a tag', () => {
  assert.equal(checkApp('maverick-admin'), 'maverick-admin')
  for (const bad of ['', 'Maverick', '-x', '1x', 'a'.repeat(31), 'x/y', undefined]) assert.throws(() => checkApp(bad), String(bad))
  assert.equal(checkCommit('a'.repeat(40)), 'a'.repeat(40))
  for (const bad of ['a'.repeat(39), 'A'.repeat(40), 'v1.2.0', undefined]) assert.throws(() => checkCommit(bad), String(bad))
})

test('checkWorkspace accepts a workspace that installs ARM64 glibc packages and injects workspace packages', () => {
  assert.deepEqual(checkWorkspace(good), [])
})

test('checkWorkspace names each missing setting', () => {
  assert.deepEqual(checkWorkspace('packages:\n  - apps/*\n'), [
    'supportedArchitectures.os must include linux',
    'supportedArchitectures.cpu must include arm64',
    'supportedArchitectures.libc must include glibc',
    'injectWorkspacePackages must be true',
  ])
  assert.deepEqual(checkWorkspace(good.replace('arm64', 'x64')), ['supportedArchitectures.cpu must include arm64'])
  assert.deepEqual(checkWorkspace(good.replace('glibc', 'musl')), ['supportedArchitectures.libc must include glibc'])
  assert.deepEqual(checkWorkspace(good.replace('true', 'false')), ['injectWorkspacePackages must be true'])
})

const fakes = (tags = []) => {
  const calls = []
  return {
    calls,
    ecr: {
      hasTag: async (repo, tag) => tags.includes(`${repo}:${tag}`),
      loginPassword: async () => 'secret',
    },
    crane: {
      login: async (registry, password) => calls.push(['login', registry, password]),
      push: async (tar, ref) => calls.push(['push', tar, ref]),
    },
  }
}

test('pushImage logs in and pushes the commit tag to the app repository', async () => {
  const f = fakes()
  const commit = 'b'.repeat(40)
  const res = await pushImage({ ...f, app: 'example-api', commit, imageTar: '/tmp/image.tar', log: () => {} })
  assert.deepEqual(res, { ref: `${REGISTRY}/coderizehq-app-example-api:${commit}`, pushed: true })
  assert.deepEqual(f.calls, [
    ['login', REGISTRY, 'secret'],
    ['push', '/tmp/image.tar', `${REGISTRY}/coderizehq-app-example-api:${commit}`],
  ])
})

test('pushImage keeps an image already pushed for the commit (tags are immutable)', async () => {
  const commit = 'c'.repeat(40)
  const f = fakes([`coderizehq-app-example-api:${commit}`])
  const res = await pushImage({ ...f, app: 'example-api', commit, imageTar: '/tmp/image.tar', log: () => {} })
  assert.equal(res.pushed, false)
  assert.deepEqual(f.calls, [])
})

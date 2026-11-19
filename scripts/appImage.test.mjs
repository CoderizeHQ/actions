import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

import { checkApp, checkCommit, checkWorkspace, imageFromTar, pushImage, REGISTRY } from './appImage.mjs'

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

// A ustar archive, as crane writes an image tarball.
function tar(files) {
  const blocks = []
  for (const [name, body] of Object.entries(files)) {
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100)
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124)
    header.write('0', 156)
    header.write('ustar\0', 257)
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)])
}

const config = Buffer.from('{"architecture":"arm64","os":"linux"}')
const layer = gzipSync(Buffer.from('app files'))
const digest = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`
const imageTar = tar({
  'manifest.json': Buffer.from(JSON.stringify([{ Config: 'sha256:aaaa', RepoTags: [], Layers: ['bbbb.tar.gz'] }])),
  'sha256:aaaa': config,
  'bbbb.tar.gz': layer,
})

test('imageFromTar builds the manifest from the bytes, not the file names', () => {
  const { manifest, blobs } = imageFromTar(imageTar)
  assert.equal(manifest.config.digest, digest(config))
  assert.deepEqual(manifest.layers.map((l) => [l.digest, l.size]), [[digest(layer), layer.length]])
  assert.deepEqual(blobs.map((b) => b.digest), [digest(config), digest(layer)])
})

test('imageFromTar refuses a tarball that is not one image with gzipped layers', () => {
  assert.throws(() => imageFromTar(tar({ 'other.txt': Buffer.from('x') })), /exactly one image/)
  const plain = tar({
    'manifest.json': Buffer.from(JSON.stringify([{ Config: 'c', Layers: ['l'] }])),
    c: config,
    l: Buffer.from('not gzipped'),
  })
  assert.throws(() => imageFromTar(plain), /gzipped/)
})

const fakeEcr = ({ tags = [], blobs = [] } = {}) => {
  const calls = []
  return {
    calls,
    hasTag: async (repo, tag) => tags.includes(`${repo}:${tag}`),
    hasBlob: async (repo, d) => blobs.includes(d),
    uploadBlob: async (repo, d) => calls.push(['upload', repo, d]),
    putManifest: async (repo, tag, manifest, mediaType) => calls.push(['manifest', repo, tag, JSON.parse(manifest).layers.length, mediaType]),
  }
}

test('pushImage uploads the missing blobs, then the manifest under the commit tag', async () => {
  const ecr = fakeEcr({ blobs: [digest(config)] })
  const commit = 'b'.repeat(40)
  const res = await pushImage({ ecr, app: 'example-api', commit, imageTar: 'x', read: async () => imageTar, log: () => {} })
  assert.deepEqual(res, { ref: `${REGISTRY}/coderizehq-app-example-api:${commit}`, pushed: true })
  assert.deepEqual(ecr.calls, [
    ['upload', 'coderizehq-app-example-api', digest(layer)],
    ['manifest', 'coderizehq-app-example-api', commit, 1, 'application/vnd.docker.distribution.manifest.v2+json'],
  ])
})

test('pushImage keeps an image already pushed for the commit (tags are immutable)', async () => {
  const commit = 'c'.repeat(40)
  const ecr = fakeEcr({ tags: [`coderizehq-app-example-api:${commit}`] })
  const res = await pushImage({ ecr, app: 'example-api', commit, imageTar: 'x', read: async () => imageTar, log: () => {} })
  assert.equal(res.pushed, false)
  assert.deepEqual(ecr.calls, [])
})

// build-app-image's helpers (platform docs/apps.md, "Images"). The image is assembled without Docker (STANDARDS.md 6:
// jobs get no Docker): the app's production files, installed for Linux ARM64 by pnpm, go in as one layer on a pinned
// Node base image for ARM64, by crane in the build job, which has no credentials. Nothing ARM runs on the x86 runner.
//
//   node appImage.mjs check   checks the app name and that the repo installs ARM64 packages (build job)
//   node appImage.mjs push    pushes the built image to the app's ECR repository through ECR's API, tagged with the
//                             commit (push job, as coderizehq-app-build-<app>; crane never runs there)

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { runIfMain, summary } from './lib/report.mjs'

export const REGISTRY = '243891826043.dkr.ecr.us-east-1.amazonaws.com'
export const repositoryName = (app) => `coderizehq-app-${app}`

/** The app's name as platform's apps/<app>.json has it: it goes into role names and the ECR repository. */
export function checkApp(app) {
  if (!/^[a-z][a-z0-9-]{0,29}$/.test(app ?? '')) throw new Error('app must start with a-z and be at most 30 of a-z, 0-9 and -')
  return app
}

/** A full commit sha, the image's tag. */
export function checkCommit(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('commit must be a 40-character sha')
  return commit
}

/**
 * The repo's pnpm-workspace.yaml must install Linux ARM64 (glibc) packages beside the runner's own, so packages with
 * native parts come as their ARM builds, and must inject workspace packages so `pnpm deploy` can copy the app out.
 * A plain-text check of the two settings, enough for the shape they're written in (docs/apps.md).
 * @param {string} yaml
 * @returns {string[]} problems
 */
export function checkWorkspace(yaml) {
  const problems = []
  const block = yaml.match(/^supportedArchitectures:\s*\n((?:[ \t]+.*\n?)+)/m)?.[1] ?? ''
  const list = (key) => block.match(new RegExp(`^\\s+${key}:\\s*\\[([^\\]]*)\\]`, 'm'))?.[1].split(',').map((s) => s.trim()) ?? []
  if (!list('os').includes('linux')) problems.push('supportedArchitectures.os must include linux')
  if (!list('cpu').includes('arm64')) problems.push('supportedArchitectures.cpu must include arm64')
  if (!list('libc').includes('glibc')) problems.push('supportedArchitectures.libc must include glibc')
  if (!/^injectWorkspacePackages:\s*true\s*$/m.test(yaml)) problems.push('injectWorkspacePackages must be true')
  return problems
}

/**
 * The files in a tar archive (plain ustar, as crane writes an image tarball), by name.
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>}
 */
export function readTar(buf) {
  const files = new Map()
  let off = 0
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const field = (from, len) => header.subarray(from, from + len).toString('utf8').replace(/\0.*$/s, '').trim()
    const prefix = field(345, 155)
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100)
    const size = parseInt(field(124, 12) || '0', 8)
    const type = field(156, 1)
    if (type === 'L' || type === 'x' || type === 'g') throw new Error(`${name}: long names and extended headers aren't expected in an image tarball`)
    off += 512
    if (type === '' || type === '0') files.set(name, buf.subarray(off, off + size))
    off += Math.ceil(size / 512) * 512
  }
  return files
}

const sha256 = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`

/**
 * The registry manifest and blobs for the image in a crane/docker image tarball (manifest.json, its config file and
 * its gzipped layers). Digests are computed from the bytes, never taken from the file names.
 */
export function imageFromTar(buf) {
  const files = readTar(buf)
  const index = JSON.parse(files.get('manifest.json')?.toString('utf8') ?? 'null')
  if (!Array.isArray(index) || index.length !== 1) throw new Error('the image tarball must hold exactly one image')
  const [{ Config, Layers }] = index
  const blob = (name) => {
    const b = files.get(name)
    if (!b) throw new Error(`the image tarball is missing ${name}`)
    return { bytes: b, digest: sha256(b), size: b.length }
  }
  const config = blob(Config)
  const layers = Layers.map(blob)
  for (const l of layers) {
    if (l.bytes[0] !== 0x1f || l.bytes[1] !== 0x8b) throw new Error('every layer in the image tarball must be gzipped')
  }
  const manifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: { mediaType: 'application/vnd.docker.container.image.v1+json', size: config.size, digest: config.digest },
    layers: layers.map((l) => ({ mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', size: l.size, digest: l.digest })),
  }
  return { manifest, blobs: [config, ...layers] }
}

/**
 * Pushes the image in image.tar to the app's ECR repository through ECR's own API (no registry client, so no
 * third-party program runs where the push role's credentials are), tagged with the commit. A tag that is already
 * there is kept: tags are immutable, so a re-run of the same commit keeps the image it pushed first.
 */
export async function pushImage({ ecr, app, commit, imageTar, read = readFile, log = console.log }) {
  const repository = repositoryName(app)
  const ref = `${REGISTRY}/${repository}:${commit}`
  if (await ecr.hasTag(repository, commit)) {
    log(`${ref} is already in ECR; keeping it`)
    return { ref, pushed: false }
  }
  const { manifest, blobs } = imageFromTar(await read(imageTar))
  for (const b of blobs) {
    if (await ecr.hasBlob(repository, b.digest)) continue
    await ecr.uploadBlob(repository, b.digest, b.bytes)
    log(`uploaded ${b.digest} (${b.size} bytes)`)
  }
  await ecr.putManifest(repository, commit, JSON.stringify(manifest), manifest.mediaType)
  log(`pushed ${ref}`)
  return { ref, pushed: true }
}

runIfMain(import.meta.url, async () => {
  const [mode] = process.argv.slice(2)
  const app = checkApp(process.env.APP)
  if (mode === 'check') {
    const problems = checkWorkspace(await readFile('pnpm-workspace.yaml', 'utf8').catch(() => ''))
    if (problems.length) throw new Error(`pnpm-workspace.yaml can't build an ARM64 image (docs/apps.md):\n${problems.map((p) => `- ${p}`).join('\n')}`)
    console.log(`${app}: pnpm-workspace.yaml installs ARM64 packages`)
  } else if (mode === 'push') {
    const { awsImages } = await import('./lib/aws.mjs')
    const commit = checkCommit(process.env.COMMIT)
    const { ref, pushed } = await pushImage({ ecr: awsImages(), app, commit, imageTar: process.env.IMAGE_TAR })
    summary(`${pushed ? 'Pushed' : 'Kept'} \`${ref}\``)
  } else {
    throw new Error('usage: node appImage.mjs check|push')
  }
})

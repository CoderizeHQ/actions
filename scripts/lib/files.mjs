// What deploy-preview and release need to know about a build's files: where they are, their hashes, and the
// headers S3 serves them with. No AWS here, so the tests run without installing anything.

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

// Hashed bundles never change under the same name, so browsers may keep them for a year. Everything else (pages,
// robots.txt, the sitemap, unhashed images in public/) can change at any deploy, so 5 minutes.
export const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable'
export const CACHE_SHORT = 'public, max-age=300'

// Astro puts its hashed output in _astro/; Vite in assets/ with a -<hash> suffix. A file elsewhere counts as hashed
// only when its name carries an 8+ character hash before the extension, as both bundlers write them.
const HASHED_DIRS = /^(_astro|assets)\//
const HASHED_NAME = /[.-][A-Za-z0-9_-]{8,}\.(js|mjs|css|woff2?|ttf|otf|svg|png|jpe?g|gif|webp|avif|ico|wasm|map)$/

/** @param {string} file a path relative to the build root, forward slashes */
export function cacheControlFor(file) {
  if (file.endsWith('.html')) return CACHE_SHORT
  const name = file.split('/').at(-1)
  if (HASHED_DIRS.test(file) && HASHED_NAME.test(name)) return CACHE_IMMUTABLE
  return CACHE_SHORT
}

const TYPES = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wasm: 'application/wasm',
}

/** @param {string} file */
export function contentTypeFor(file) {
  const ext = file.split('/').at(-1).split('.').at(-1).toLowerCase()
  return TYPES[ext] ?? 'application/octet-stream'
}

/** @param {Buffer} body */
export function hashes(body) {
  return {
    size: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    md5: createHash('md5').update(body).digest('hex'),
  }
}

/** S3 returns SHA-256 checksums base64-encoded; the manifest keeps them as hex. */
export const sha256HexToBase64 = (hex) => Buffer.from(hex, 'hex').toString('base64')
export const sha256Base64ToHex = (b64) => Buffer.from(b64, 'base64').toString('hex')

/** S3 quotes ETags. For a single-part upload or copy of an SSE-S3 object, the ETag is the content's MD5. */
export const plainEtag = (etag) => String(etag ?? '').replaceAll('"', '')

/**
 * Every file under the build root, sorted, with its size and hashes. Refuses symlinks (a build that links outside
 * itself would publish whatever it points at) and paths S3 or the router would treat differently.
 * @param {string} root
 * @returns {Promise<{ path: string, size: number, sha256: string, md5: string }[]>}
 */
export async function walkBuild(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(entry.parentPath, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`the build contains a symlink: ${path.relative(root, full)}`)
    if (!entry.isFile()) continue
    const rel = path.relative(root, full).split(path.sep).join('/')
    checkPath(rel)
    files.push({ path: rel, ...hashes(await readFile(full)) })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (files.length === 0) throw new Error(`the build at ${root} has no files`)
  return files
}

/** @param {string} rel */
export function checkPath(rel) {
  if (!rel || rel.startsWith('/') || rel.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`unsafe path in the build: ${JSON.stringify(rel)}`)
  }
  // Control characters and backslashes don't survive the trip through S3 keys, copy-source headers and URLs intact.
  if (/[\u0000-\u001f\u007f\\]/.test(rel)) throw new Error(`unsupported character in a build path: ${JSON.stringify(rel)}`)
}

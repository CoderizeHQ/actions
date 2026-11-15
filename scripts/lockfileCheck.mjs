// ci-site's lockfile check (plan, Phase 3 "Shared workflows", ci-site): every package in pnpm-lock.yaml comes from the
// npm registry with a checksum, and that checksum is the one the registry publishes for that version. Runs on the
// committed lockfile before the install, so a lockfile can't point the install at a tarball, a git repo or a folder,
// and can't carry a checksum of its own making: the runners install through a cache (Verdaccio) that the lockfile's
// integrity is checked against, so the registry is the only independent witness.
//
// A committed .npmrc may not point any scope at another registry either. The rule that a lockfile change needs a
// package.json change (Renovate's lockfile updates apart) stays in the workflow, where the PR's facts are.

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { runIfMain, summary } from './lib/report.mjs'

export const REGISTRY = 'https://registry.npmjs.org/'
const CONCURRENCY = 8

/** `{integrity: sha512-..., tarball: https://...}` → an object. */
export function parseFlowMap(text) {
  const out = {}
  for (const m of text.matchAll(/([\w-]+):\s*([^,}]+)/g)) out[m[1]] = m[2].trim().replace(/^'(.*)'$/, '$1')
  return out
}

/** `'@scope/name@1.2.3'` → `{ name: '@scope/name', version: '1.2.3' }`. */
export function parseKey(key) {
  const k = key.replace(/^'(.*)'$/, '$1')
  const at = k.indexOf('@', 1)
  return at < 0 ? { name: k, version: '' } : { name: k.slice(0, at), version: k.slice(at + 1) }
}

/**
 * The entries of every `packages:` section of a pnpm-lock.yaml (v9; pnpm 11+ writes two YAML documents, the first
 * for pnpm itself). Line-based, because pnpm writes this part in one fixed shape: keys two spaces in, `resolution:`
 * four spaces in, on one line.
 * @param {string} text
 * @returns {{ key: string, name: string, version: string, resolution: Record<string, string> | null }[]}
 */
export function lockfilePackages(text) {
  const entries = []
  let inPackages = false
  let current = null
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inPackages = line.trimEnd() === 'packages:'
      current = null
      continue
    }
    if (!inPackages) continue
    const key = /^ {2}(\S.*):\s*$/.exec(line)
    if (key) {
      current = { key: key[1], ...parseKey(key[1]), resolution: null }
      entries.push(current)
      continue
    }
    const res = /^ {4}resolution:\s*\{(.*)\}\s*$/.exec(line)
    if (res && current) current.resolution = parseFlowMap(res[1])
  }
  return entries
}

/** Problems with the entries themselves, without asking the registry. */
export function entryProblems(entries) {
  const problems = []
  for (const e of entries) {
    const r = e.resolution
    if (!r) problems.push(`${e.key} has no resolution`)
    else if (r.type || r.commit || r.repo || r.directory || r.path) problems.push(`${e.key} is not from the npm registry (${Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(', ')})`)
    else if (r.tarball && !r.tarball.startsWith(REGISTRY)) problems.push(`${e.key} downloads from ${r.tarball}, not ${REGISTRY}`)
    else if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(r.integrity ?? '')) problems.push(`${e.key} has no sha512 integrity checksum`)
  }
  return problems
}

/** Lines of a committed .npmrc that send installs anywhere but the npm registry. */
export function npmrcProblems(text) {
  const problems = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const m = /^((?:@[^:\s]+:)?registry)\s*=\s*(.+)$/.exec(line)
    if (m && m[2].replace(/\/?$/, '/') !== REGISTRY) problems.push(`.npmrc sets ${m[1]} to ${m[2]}; only ${REGISTRY} is allowed`)
  }
  return problems
}

/** The registry's metadata URL for one version. */
export function versionUrl(name, version) {
  return `${REGISTRY}${name.replace('/', '%2F')}/${encodeURIComponent(version)}`
}

/**
 * Asks the registry for each version's published checksum and compares it with the lockfile's.
 * @param {{ key: string, name: string, version: string, resolution: Record<string, string> }[]} entries
 * @param {typeof fetch} [fetchImpl]
 */
export async function registryProblems(entries, fetchImpl = fetch) {
  const problems = []
  const queue = [...entries]
  async function worker() {
    for (let e = queue.shift(); e; e = queue.shift()) {
      const url = versionUrl(e.name, e.version)
      let res
      for (let attempt = 1; ; attempt++) {
        res = await fetchImpl(url, { headers: { accept: 'application/json' } })
        if (res.status < 500 || attempt === 3) break
      }
      if (res.status === 404) {
        problems.push(`${e.key} is not on the npm registry`)
        continue
      }
      if (!res.ok) throw new Error(`${url}: ${res.status}`)
      const published = (await res.json())?.dist?.integrity
      if (published !== e.resolution.integrity) {
        problems.push(`${e.key}: the lockfile's checksum is not the one the npm registry publishes (${published ?? 'none'})`)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  return problems.sort()
}

async function main() {
  const dir = path.resolve(process.env.REPO_DIR ?? '.')
  const lockfile = await readFile(path.join(dir, 'pnpm-lock.yaml'), 'utf8').catch(() => null)
  if (lockfile === null) throw new Error('pnpm-lock.yaml is missing; commit the lockfile pnpm install writes')
  const npmrc = await readFile(path.join(dir, '.npmrc'), 'utf8').catch(() => '')

  // The same package can appear in both YAML documents.
  const entries = [...new Map(lockfilePackages(lockfile).map((e) => [e.key, e])).values()]
  const problems = [...npmrcProblems(npmrc), ...entryProblems(entries)]
  // Checking the registry only makes sense for entries that claim to come from it.
  if (!problems.length) problems.push(...(await registryProblems(entries)))

  if (problems.length) {
    for (const p of problems) console.log(`::error::${p}`)
    summary(`### Lockfile\n\n${problems.map((p) => `- ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`${entries.length} packages in pnpm-lock.yaml, each from ${REGISTRY} with the checksum it publishes.`)
}

runIfMain(import.meta.url, main)

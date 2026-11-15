// ci-site's package checks (plan, Phase 3 "Shared workflows", ci-site), on the committed files before anything from
// the repo runs:
// - every dependency in every package.json has a real version range: never a dist-tag (`latest`, `next`), `*`, `x`
//   or an empty string, which resolve differently on each install and silently defeat overrides; `workspace:`,
//   `catalog:`, `link:` and `file:` are fine, and an `npm:` alias is judged by its own range;
// - no package-lock.json, npm-shrinkwrap.json or yarn.lock: pnpm is the only package manager, and a second lockfile
//   means someone installed with something else.
// Package.json key order is checked by sort-package-json itself, in the workflow.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { runIfMain, summary } from './lib/report.mjs'

export const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies']
export const OTHER_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock']
const LOCAL_PROTOCOLS = ['workspace:', 'catalog:', 'link:', 'file:']

/**
 * Why a version specifier floats, or null when it's a real range.
 * @param {string} spec
 * @returns {string | null}
 */
export function floatingReason(spec) {
  const s = String(spec ?? '').trim()
  if (LOCAL_PROTOCOLS.some((p) => s.startsWith(p))) return null
  if (s.startsWith('npm:')) {
    const at = s.lastIndexOf('@')
    return at > 'npm:'.length ? floatingReason(s.slice(at + 1)) : 'an npm: alias with no version'
  }
  if (s === '') return 'an empty version'
  if (/^[*xX](\.[*xX]){0,2}$/.test(s)) return `"${s}" matches any version`
  if (/^[a-z][a-z0-9+.-]*:|^[\w.-]+\/[\w.-]+(#.*)?$/i.test(s))return `"${s}" is not a version from the npm registry`
  if (/^[a-z][a-z0-9-]*$/i.test(s)) return `"${s}" is a dist-tag`
  return null
}

/**
 * The floating specifiers in one parsed package.json.
 * @param {Record<string, any>} pkg @param {string} file
 */
export function floatingSpecifiers(pkg, file) {
  const problems = []
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      const reason = floatingReason(spec)
      if (reason) problems.push(`${file}: ${field}.${name} is ${reason}; pin a range such as ^1.2.3`)
    }
  }
  return problems
}

/** @param {string[]} files every tracked file, forward slashes */
export function otherLockfiles(files) {
  return files
    .filter((f) => OTHER_LOCKFILES.includes(path.posix.basename(f)))
    .map((f) => `${f} is committed; this repo installs with pnpm only (pnpm-lock.yaml), so remove it`)
}

/** Every problem in the repo at `dir`, from its tracked files. */
export function checkPackages(dir, files) {
  const problems = otherLockfiles(files)
  for (const file of files.filter((f) => path.posix.basename(f) === 'package.json' && !f.includes('node_modules/'))) {
    let pkg
    try {
      pkg = JSON.parse(readFileSync(path.join(dir, file), 'utf8'))
    } catch (err) {
      problems.push(`${file} is not valid JSON: ${err.message}`)
      continue
    }
    problems.push(...floatingSpecifiers(pkg, file))
  }
  return problems
}

export function trackedFiles(dir) {
  return execFileSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
}

async function main() {
  const dir = path.resolve(process.env.REPO_DIR ?? '.')
  const problems = checkPackages(dir, trackedFiles(dir))
  if (problems.length) {
    for (const p of problems) console.log(`::error::${p}`)
    summary(`### Package checks\n\n${problems.map((p) => `- ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log('Every dependency has a real range, and pnpm-lock.yaml is the only lockfile.')
}

runIfMain(import.meta.url, main)

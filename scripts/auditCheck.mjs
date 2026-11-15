// The dependency audit ci-site and ci-node run (plan, Phase 3 "Shared workflows"): `pnpm audit` (pnpm 11+ asks the
// npm registry's bulk advisory endpoint), failing on any advisory at moderate or above that isn't ignored.
//
// Ignores live in the repo's audit-ignore.json, and each one needs a reason and an expiry date:
//   [{ "id": "GHSA-xxxx-xxxx-xxxx", "reason": "only reachable from the build, never shipped", "expires": "2026-12-31" }]
// An expired ignore fails the check, so an exception can't quietly become permanent. pnpm's own auditConfig
// (package.json or pnpm-workspace.yaml) is refused, since it takes neither a reason nor a date.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { runIfMain, summary } from './lib/report.mjs'

export const IGNORE_FILE = 'audit-ignore.json'
export const FAILING = new Set(['moderate', 'high', 'critical'])
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/

/**
 * Checks the ignore file's entries.
 * @param {unknown} list the parsed audit-ignore.json
 * @param {string} today YYYY-MM-DD (UTC)
 * @returns {{ ids: Set<string>, problems: string[] }}
 */
export function readIgnores(list, today) {
  const problems = []
  const ids = new Set()
  if (!Array.isArray(list)) return { ids, problems: [`${IGNORE_FILE} must be a JSON array of { id, reason, expires }`] }
  for (const [i, entry] of list.entries()) {
    const where = `${IGNORE_FILE}[${i}]`
    const { id, reason, expires } = entry ?? {}
    if (typeof id !== 'string' || !GHSA.test(id)) {
      problems.push(`${where}: id must be a GitHub advisory id (GHSA-xxxx-xxxx-xxxx), not ${JSON.stringify(id)}`)
      continue
    }
    if (ids.has(id)) problems.push(`${where}: ${id} is listed twice`)
    if (typeof reason !== 'string' || reason.trim().length < 10) problems.push(`${where}: ${id} needs a reason (why it's safe to ship, in a sentence)`)
    if (typeof expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) {
      problems.push(`${where}: ${id} needs an expiry date (expires: YYYY-MM-DD)`)
    } else if (expires < today) {
      problems.push(`${where}: the ignore for ${id} expired on ${expires}; fix the dependency or renew the ignore with a new reason`)
    }
    ids.add(id)
  }
  return { ids, problems }
}

/** Refuses pnpm's own audit ignores, which skip both the reason and the date. */
export function auditConfigProblems(pkg, workspaceYaml) {
  const problems = []
  if (pkg?.pnpm?.auditConfig) problems.push(`package.json sets pnpm.auditConfig; list ignores in ${IGNORE_FILE} instead, each with a reason and an expiry`)
  if (/^auditConfig\s*:/m.test(workspaceYaml ?? '')) problems.push(`pnpm-workspace.yaml sets auditConfig; list ignores in ${IGNORE_FILE} instead, each with a reason and an expiry`)
  return problems
}

/**
 * Judges `pnpm audit --json` output against the ignores.
 * @param {{ advisories?: Record<string, any> }} report
 * @param {Set<string>} ignored
 */
export function judgeAudit(report, ignored) {
  const failing = []
  const skipped = []
  const used = new Set()
  for (const a of Object.values(report.advisories ?? {})) {
    if (!FAILING.has(a.severity)) continue
    const id = a.github_advisory_id
    const line = `${a.module_name} ${a.findings?.map((f) => f.version).join(', ') ?? ''}: ${id} [${a.severity}] ${a.title} (fixed in ${a.patched_versions})`
    if (ignored.has(id)) {
      used.add(id)
      skipped.push(line)
    } else failing.push(line)
  }
  const unused = [...ignored].filter((id) => !used.has(id))
  return { failing: failing.sort(), skipped: skipped.sort(), unused }
}

/** Runs `pnpm audit --json` in `dir`; it exits non-zero when it finds anything, so the output decides. */
export async function runAudit(dir) {
  const { stdout } = await promisify(execFile)('pnpm', ['audit', '--json'], { cwd: dir, maxBuffer: 64 * 1024 * 1024 }).catch((err) => err)
  try {
    const report = JSON.parse(stdout)
    if (report.error) throw new Error(report.error.message ?? JSON.stringify(report.error))
    return report
  } catch (err) {
    throw new Error(`pnpm audit gave no report: ${err.message}\n${String(stdout).slice(0, 2000)}`)
  }
}

async function main() {
  const dir = path.resolve(process.env.REPO_DIR ?? '.')
  const today = new Date().toISOString().slice(0, 10)
  const readText = (f) => readFile(path.join(dir, f), 'utf8').catch(() => null)

  const problems = []
  let ignores = { ids: new Set(), problems: [] }
  const ignoreText = await readText(IGNORE_FILE)
  if (ignoreText !== null) {
    try {
      ignores = readIgnores(JSON.parse(ignoreText), today)
    } catch (err) {
      ignores.problems.push(`${IGNORE_FILE} is not valid JSON: ${err.message}`)
    }
  }
  problems.push(...ignores.problems)
  problems.push(...auditConfigProblems(JSON.parse((await readText('package.json')) ?? '{}'), await readText('pnpm-workspace.yaml')))

  const { failing, skipped, unused } = judgeAudit(await runAudit(dir), ignores.ids)
  for (const line of skipped) console.log(`::notice::ignored by ${IGNORE_FILE}: ${line}`)
  for (const id of unused) console.log(`::notice::${IGNORE_FILE} ignores ${id}, which no longer applies; remove it`)
  problems.push(...failing)

  if (problems.length) {
    for (const p of problems) console.log(`::error::${p}`)
    summary(`### Dependency audit\n\n${problems.map((p) => `- ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`No advisories at moderate or above${skipped.length ? ` apart from ${skipped.length} ignored` : ''}.`)
}

runIfMain(import.meta.url, main)

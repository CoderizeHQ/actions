// ci-node's test database (STANDARDS.md 6: jobs get no Docker; a test that needs Postgres uses a temporary Neon
// branch). With `test-database: true`, ci-node makes a branch of the CI Neon project before the tests and deletes it
// after, whatever happened. The CI project holds no client data: its main is an empty database, so a branch starts
// empty and the repo's own test setup migrates it. Its API key (NEON_CI_API_KEY, an organization secret) is scoped to
// that one project, so a test run can never reach a client database.
//
//   node scripts/neonTestBranch.mjs create   names the branch from the run, makes it with a compute, writes
//                                            DATABASE_URL and DIRECT_URL (masked) to GITHUB_ENV and the branch id to
//                                            GITHUB_OUTPUT
//   node scripts/neonTestBranch.mjs delete <branch id>
//   node scripts/neonTestBranch.mjs sweep    deletes ci- branches older than two hours (a run killed before its
//                                            delete step), so the project never fills up
//
// Env: NEON_API_KEY, NEON_PROJECT_ID, and for create GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT.

import { appendFileSync } from 'node:fs'

import { output, runIfMain } from './lib/report.mjs'

export const API = 'https://console.neon.tech/api/v2'
export const PREFIX = 'ci-'
export const MAX_AGE_MS = 2 * 60 * 60 * 1000

/** The branch name for this run: ci-<repo>-<run id>-<attempt>, within Neon's 256 characters. */
export function branchName({ repository, runId, attempt }) {
  const repo = String(repository ?? '').split('/').pop()
  if (!/^[a-z0-9-]+$/.test(repo) || !/^\d+$/.test(String(runId)) || !/^\d+$/.test(String(attempt ?? '1'))) {
    throw new Error('neonTestBranch: GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT are needed')
  }
  return `${PREFIX}${repo}-${runId}-${attempt ?? 1}`.slice(0, 256)
}

/** The pooled URL's direct twin: the same URL without -pooler in the host (Migrate needs a real session). */
export function directUrl(pooled) {
  const u = new URL(pooled)
  u.hostname = u.hostname.replace('-pooler.', '.')
  return u.toString()
}

/** Branches to sweep: ours (ci- prefix), older than MAX_AGE_MS, never the project's default. */
export function stale(branches, now = Date.now()) {
  return branches.filter((b) => b.name?.startsWith(PREFIX) && !b.default && !b.primary && now - Date.parse(b.created_at) > MAX_AGE_MS)
}

/** A small Neon API client. `fetchImpl` is for tests. */
export function neon({ apiKey, projectId, fetchImpl = fetch }) {
  if (!apiKey || !projectId) throw new Error('neonTestBranch: NEON_API_KEY and NEON_PROJECT_ID are needed (test-database: true)')
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${API}/projects/${projectId}${path}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (res.status === 404 && method === 'DELETE') return null
    if (!res.ok) throw new Error(`Neon ${method} ${path}: HTTP ${res.status}`)
    return res.status === 204 ? null : res.json()
  }
  return {
    create: (name) =>
      call('POST', '/branches', {
        branch: { name },
        endpoints: [{ type: 'read_write', autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 0.5, suspend_timeout_seconds: 300 }],
      }),
    remove: (id) => call('DELETE', `/branches/${id}`),
    list: () => call('GET', '/branches'),
  }
}

/** Makes the branch and returns its id and the two URLs. */
export async function create(api, name) {
  const made = await api.create(name)
  const id = made?.branch?.id
  const pooled = made?.connection_uris?.[0]?.connection_uri
  if (!id || !pooled) throw new Error('Neon made no branch or no connection URI')
  const u = new URL(pooled)
  u.hostname = u.hostname.includes('-pooler.') ? u.hostname : u.hostname.replace(/^([^.]+)\./, '$1-pooler.')
  return { id, databaseUrl: u.toString(), directUrl: directUrl(u.toString()) }
}

async function main() {
  const [command, id] = process.argv.slice(2)
  const api = neon({ apiKey: process.env.NEON_API_KEY, projectId: process.env.NEON_PROJECT_ID })
  if (command === 'create') {
    const name = branchName({ repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT })
    const made = await create(api, name)
    // Masked before anything could print them; only the job's own environment gets them.
    console.log(`::add-mask::${made.databaseUrl}`)
    console.log(`::add-mask::${made.directUrl}`)
    console.log(`::add-mask::${new URL(made.databaseUrl).password}`)
    if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `DATABASE_URL=${made.databaseUrl}\nDIRECT_URL=${made.directUrl}\n`)
    output('branch', made.id)
    console.log(`Test database: Neon branch ${name} (${made.id})`)
  } else if (command === 'delete') {
    if (!/^br-[a-z0-9-]+$/.test(id ?? '')) throw new Error('neonTestBranch delete: a br-... branch id is needed')
    await api.remove(id)
    console.log(`Deleted the test branch ${id}`)
  } else if (command === 'sweep') {
    const old = stale((await api.list())?.branches ?? [])
    for (const b of old) await api.remove(b.id)
    console.log(`Swept ${old.length} leftover test branch(es)`)
  } else {
    throw new Error('usage: neonTestBranch.mjs create | delete <branch id> | sweep')
  }
}

runIfMain(import.meta.url, main)

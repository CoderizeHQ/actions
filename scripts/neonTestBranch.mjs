// ci-node's test database (STANDARDS.md 6: jobs get no Docker; a test that needs Postgres uses a temporary Neon
// branch). With `test-database: true`, ci-node makes a branch of the CI Neon project in a job of its own before the
// tests, and deletes it in another job after, whatever happened. The CI project holds no client data: its main is an
// empty database, and must stay that way.
//
// The API key (NEON_CI_API_KEY, scoped to the CI project) only ever reaches these two jobs, which run no code from the
// repo under test: they check out nothing but actions at this workflow's own commit. The tests get a role and a
// database made on this branch alone (`ci_tests`, owning `tests`), with a random password Neon generates: that role
// exists nowhere else (not on main, not on other runs' branches) and goes when the branch is deleted. The project's
// own owner password never reaches a test.
//
//   node scripts/neonTestBranch.mjs create   sweeps leftovers (best effort), names the branch from the run, makes it
//                                            with a compute, a role and a database, and writes branch, host (pooled)
//                                            and password to GITHUB_OUTPUT
//   node scripts/neonTestBranch.mjs delete <branch id>
//
// Env: NEON_API_KEY, NEON_PROJECT_ID, and for create GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT.

import { output, runIfMain } from './lib/report.mjs'

export const API = 'https://console.neon.tech/api/v2'
export const PREFIX = 'ci-'
export const ROLE = 'ci_tests'
export const DATABASE = 'tests'
// Longer than ci-node's job timeout (60 minutes), so a sweep never removes a branch a running job still uses.
export const MAX_AGE_MS = 3 * 60 * 60 * 1000

/** The branch name for this run: ci-<repo>-<run id>-<attempt>, within Neon's 256 characters. */
export function branchName({ repository, runId, attempt }) {
  const repo = String(repository ?? '').split('/').pop()
  if (!/^[a-z0-9-]+$/.test(repo) || !/^\d+$/.test(String(runId)) || !/^\d+$/.test(String(attempt ?? '1'))) {
    throw new Error('neonTestBranch: GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT are needed')
  }
  return `${PREFIX}${repo}-${runId}-${attempt ?? 1}`.slice(0, 256)
}

/** Branches to sweep: ours (ci- prefix), older than MAX_AGE_MS, never the project's default or primary. */
export function stale(branches, now = Date.now()) {
  return branches.filter((b) => b.name?.startsWith(PREFIX) && !b.default && !b.primary && now - Date.parse(b.created_at) > MAX_AGE_MS)
}

/** The pooled twin of an endpoint host: ep-x.c-1... -> ep-x-pooler.c-1... */
export function pooledHost(host) {
  return host.includes('-pooler.') ? host : host.replace(/^([^.]+)\./, '$1-pooler.')
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
    if (!res.ok) throw new Error(`Neon ${method} ${path.split('?')[0]}: HTTP ${res.status}`)
    return res.status === 204 ? null : res.json()
  }
  return {
    create: (name) =>
      call('POST', '/branches', {
        branch: { name },
        endpoints: [{ type: 'read_write', autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 0.5, suspend_timeout_seconds: 300 }],
      }),
    remove: (id) => call('DELETE', `/branches/${id}`),
    role: (id) => call('POST', `/branches/${id}/roles`, { role: { name: ROLE } }),
    database: (id) => call('POST', `/branches/${id}/databases`, { database: { name: DATABASE, owner_name: ROLE } }),
    /** Every branch, following the API's cursor (100 a page), so a large backlog is swept whole. */
    async listAll() {
      const all = []
      let cursor = ''
      for (let page = 0; page < 100; page++) {
        const got = await call('GET', `/branches?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        all.push(...(got?.branches ?? []))
        cursor = got?.pagination?.next ?? ''
        if (!cursor || !(got?.branches ?? []).length) break
      }
      return all
    },
  }
}

/** Deletes leftovers, best effort: a branch it can't list or delete is warned about, never a reason to fail the run. */
export async function sweep(api, log = console.log) {
  let old = []
  try {
    old = stale(await api.listAll())
  } catch (err) {
    log(`::warning::couldn't list the CI project's branches to sweep: ${err.message}`)
  }
  for (const b of old) {
    try {
      await api.remove(b.id)
    } catch (err) {
      log(`::warning::couldn't delete the leftover test branch ${b.id}: ${err.message}`)
    }
  }
}

/** Sweeps leftovers, then makes this run's branch, role and database. The id is written first, so cleanup can run. */
export async function create(api, name, setOutput = output, log = console.log) {
  await sweep(api, log)
  const made = await api.create(name)
  const id = made?.branch?.id
  if (!id) throw new Error('Neon made no branch')
  setOutput('branch', id)
  const host = made?.endpoints?.[0]?.host
  if (!host) throw new Error(`Neon made branch ${id} without a compute host`)
  const password = (await api.role(id))?.role?.password
  if (!password) throw new Error(`Neon made no ${ROLE} role on branch ${id}`)
  await api.database(id)
  setOutput('host', pooledHost(host))
  // Not masked here: a masked value can't leave the job as an output. The test job masks it before any use. It opens
  // only this branch's own empty database, which is deleted after the run.
  setOutput('password', password)
  return { id, host: pooledHost(host) }
}

async function main() {
  const [command, id] = process.argv.slice(2)
  const api = neon({ apiKey: process.env.NEON_API_KEY, projectId: process.env.NEON_PROJECT_ID })
  if (command === 'create') {
    const name = branchName({ repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT })
    const made = await create(api, name)
    console.log(`Test database: Neon branch ${name} (${made.id})`)
  } else if (command === 'delete') {
    if (!/^br-[a-z0-9-]+$/.test(id ?? '')) throw new Error('neonTestBranch delete: a br-... branch id is needed')
    await api.remove(id)
    console.log(`Deleted the test branch ${id}`)
  } else {
    throw new Error('usage: neonTestBranch.mjs create | delete <branch id>')
  }
}

runIfMain(import.meta.url, main)

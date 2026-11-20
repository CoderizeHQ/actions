import assert from 'node:assert/strict'
import { test } from 'node:test'

import { API, MAX_AGE_MS, branchName, create, neon, pooledHost, stale } from './neonTestBranch.mjs'

test('branchName names the run, and refuses anything odd', () => {
  assert.equal(branchName({ repository: 'CoderizeHQ/mrleejunkcarbuyer-com-mono', runId: '123', attempt: '2' }), 'ci-mrleejunkcarbuyer-com-mono-123-2')
  assert.throws(() => branchName({ repository: 'CoderizeHQ/x;rm', runId: '1', attempt: '1' }))
  assert.throws(() => branchName({ repository: 'CoderizeHQ/x', runId: 'abc', attempt: '1' }))
})

test('pooledHost adds -pooler to the endpoint label once', () => {
  assert.equal(pooledHost('ep-a-b.c-1.us-east-1.aws.neon.tech'), 'ep-a-b-pooler.c-1.us-east-1.aws.neon.tech')
  assert.equal(pooledHost('ep-a-b-pooler.c-1.us-east-1.aws.neon.tech'), 'ep-a-b-pooler.c-1.us-east-1.aws.neon.tech')
})

test('stale picks only ci- branches older than the job timeout, never the default', () => {
  const now = Date.parse('2026-11-20T12:00:00Z')
  const old = new Date(now - MAX_AGE_MS - 1000).toISOString()
  const fresh = new Date(now - 60 * 60 * 1000).toISOString()
  const got = stale(
    [
      { id: 'br-1', name: 'ci-a-1-1', created_at: old },
      { id: 'br-2', name: 'ci-a-2-1', created_at: fresh },
      { id: 'br-3', name: 'main', created_at: old, default: true },
      { id: 'br-4', name: 'ci-main', created_at: old, primary: true },
    ],
    now,
  )
  assert.deepEqual(got.map((b) => b.id), ['br-1'])
  assert.ok(MAX_AGE_MS > 60 * 60 * 1000, 'longer than the 60-minute job timeout')
})

function fakeFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.authorization })
    const key = `${init.method} ${url.replace(API, '').split('?')[0]}`
    const r = routes[key]
    if (!r) return { ok: false, status: 500 }
    const body = typeof r === 'function' ? r(url) : r
    return { ok: true, status: 200, json: async () => body }
  }
  return { calls, fetchImpl }
}

test('create sweeps leftovers, makes the branch, and outputs only the id and the pooled host', async () => {
  const old = new Date(Date.now() - MAX_AGE_MS - 60000).toISOString()
  const { calls, fetchImpl } = fakeFetch({
    'GET /projects/proj/branches': { branches: [{ id: 'br-old', name: 'ci-r-9-1', created_at: old }] },
    'DELETE /projects/proj/branches/br-old': {},
    'POST /projects/proj/branches': { branch: { id: 'br-new' }, endpoints: [{ host: 'ep-x.c-1.aws.neon.tech' }], connection_uris: [{ connection_uri: 'postgresql://u:secret@ep-x.c-1.aws.neon.tech/neondb' }] },
  })
  const outputs = {}
  const got = await create(neon({ apiKey: 'k', projectId: 'proj', fetchImpl }), 'ci-r-1-1', (k, v) => (outputs[k] = v))
  assert.deepEqual(
    calls.map((c) => c.method),
    ['GET', 'DELETE', 'POST'],
  )
  assert.equal(calls[2].body.branch.name, 'ci-r-1-1')
  assert.equal(calls[2].body.endpoints[0].type, 'read_write')
  assert.equal(calls[2].auth, 'Bearer k')
  assert.deepEqual(outputs, { branch: 'br-new', host: 'ep-x-pooler.c-1.aws.neon.tech' })
  assert.ok(!JSON.stringify(outputs).includes('secret'), 'no password in any output')
  assert.equal(got.id, 'br-new')
})

test('create writes the branch id before failing on a missing host, so cleanup still runs', async () => {
  const { fetchImpl } = fakeFetch({
    'GET /projects/p/branches': { branches: [] },
    'POST /projects/p/branches': { branch: { id: 'br-half' }, endpoints: [] },
  })
  const outputs = {}
  await assert.rejects(create(neon({ apiKey: 'k', projectId: 'p', fetchImpl }), 'ci-r-1-1', (k, v) => (outputs[k] = v)), /without a compute host/)
  assert.equal(outputs.branch, 'br-half')
})

test('listAll follows the cursor', async () => {
  let n = 0
  const { fetchImpl } = fakeFetch({
    'GET /projects/p/branches': () => (++n === 1 ? { branches: [{ id: 'br-1' }], pagination: { next: 'c2' } } : { branches: [{ id: 'br-2' }], pagination: {} }),
  })
  const all = await neon({ apiKey: 'k', projectId: 'p', fetchImpl }).listAll()
  assert.deepEqual(all.map((b) => b.id), ['br-1', 'br-2'])
})

test('a delete of a branch already gone is fine; other failures throw', async () => {
  const api404 = neon({ apiKey: 'k', projectId: 'p', fetchImpl: async () => ({ ok: false, status: 404 }) })
  assert.equal(await api404.remove('br-x'), null)
  const api500 = neon({ apiKey: 'k', projectId: 'p', fetchImpl: async () => ({ ok: false, status: 500 }) })
  await assert.rejects(api500.remove('br-x'), /HTTP 500/)
})

test('neon refuses to start without a key or project', () => {
  assert.throws(() => neon({ apiKey: '', projectId: 'p' }), /NEON_API_KEY/)
})

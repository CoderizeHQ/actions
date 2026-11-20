import assert from 'node:assert/strict'
import { test } from 'node:test'

import { API, branchName, create, directUrl, neon, stale } from './neonTestBranch.mjs'

test('branchName names the run, and refuses anything odd', () => {
  assert.equal(branchName({ repository: 'CoderizeHQ/mrleejunkcarbuyer-com-mono', runId: '123', attempt: '2' }), 'ci-mrleejunkcarbuyer-com-mono-123-2')
  assert.throws(() => branchName({ repository: 'CoderizeHQ/x;rm', runId: '1', attempt: '1' }))
  assert.throws(() => branchName({ repository: 'CoderizeHQ/x', runId: 'abc', attempt: '1' }))
})

test('directUrl drops -pooler from the host only', () => {
  assert.equal(
    directUrl('postgresql://u:p@ep-a-b-pooler.c-1.us-east-1.aws.neon.tech/neondb?sslmode=require'),
    'postgresql://u:p@ep-a-b.c-1.us-east-1.aws.neon.tech/neondb?sslmode=require',
  )
})

test('stale picks only old ci- branches, never the default', () => {
  const now = Date.parse('2026-11-20T12:00:00Z')
  const got = stale(
    [
      { id: 'br-1', name: 'ci-a-1-1', created_at: '2026-11-20T09:00:00Z' },
      { id: 'br-2', name: 'ci-a-2-1', created_at: '2026-11-20T11:30:00Z' },
      { id: 'br-3', name: 'main', created_at: '2026-11-01T00:00:00Z', default: true },
      { id: 'br-4', name: 'ci-main', created_at: '2026-11-01T00:00:00Z', default: true },
    ],
    now,
  )
  assert.deepEqual(got.map((b) => b.id), ['br-1'])
})

test('create posts a branch with a compute and returns pooled and direct URLs', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 201,
      json: async () => ({ branch: { id: 'br-new' }, connection_uris: [{ connection_uri: 'postgresql://u:p@ep-x.c-1.aws.neon.tech/neondb?sslmode=require' }] }),
    }
  }
  const got = await create(neon({ apiKey: 'k', projectId: 'proj', fetchImpl }), 'ci-r-1-1')
  assert.equal(calls[0].url, `${API}/projects/proj/branches`)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer k')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.branch.name, 'ci-r-1-1')
  assert.equal(body.endpoints[0].type, 'read_write')
  assert.equal(got.id, 'br-new')
  assert.equal(got.databaseUrl, 'postgresql://u:p@ep-x-pooler.c-1.aws.neon.tech/neondb?sslmode=require')
  assert.equal(got.directUrl, 'postgresql://u:p@ep-x.c-1.aws.neon.tech/neondb?sslmode=require')
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

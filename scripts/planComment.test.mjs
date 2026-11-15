import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatComment, headline, MARKER } from './planComment.mjs'

const plan = (root, status, text = '', reason) => ({ result: { root, status, reason }, text })

test('each root gets its plan summary line', () => {
  assert.equal(headline({ status: 'planned' }, 'x\n\nPlan: 1 to add, 0 to change, 0 to destroy.\n'), 'Plan: 1 to add, 0 to change, 0 to destroy.')
  assert.equal(headline({ status: 'planned' }, 'No changes. Your infrastructure matches the configuration.'), 'No changes. Your infrastructure matches the configuration.')
  assert.equal(headline({ status: 'failed' }, 'Error: x'), 'plan failed')
  assert.equal(headline({ status: 'skipped', reason: 'needs a read-only Cloudflare token' }, ''), 'skipped: needs a read-only Cloudflare token')
})

test('the comment starts with the marker, lists roots in order and fences each plan', () => {
  const body = formatComment(
    [plan('aws/preview', 'planned', 'Plan: 2 to add, 0 to change, 0 to destroy.'), plan('aws/live', 'skipped', '', 'no token'), plan('tofu', 'failed', 'Error: ```boom```')],
    'abcdef1234567890',
  )
  assert.ok(body.startsWith(MARKER))
  assert.ok(body.indexOf('`aws/live`') < body.indexOf('`aws/preview`'))
  assert.match(body, /`abcdef1`/)
  assert.equal(body.match(/<details>/g).length, 2, 'no plan block for a skipped root')
  assert.equal(body.split('```').length - 1, 4, "a plan's own fences can't break out")
})

test("a root's note shows under its heading", () => {
  const tofu = { result: { root: 'tofu', status: 'planned', note: "against the last applied state; live GitHub settings aren't read" }, text: 'No changes.' }
  const body = formatComment([tofu, plan('aws/live', 'planned', 'No changes.')], 'a'.repeat(40))
  assert.match(body, /#### `tofu`: No changes\.\n\nPlanned against the last applied state; live GitHub settings aren't read\./)
  assert.equal(body.match(/Planned against/g).length, 1, 'only the root with a note')
})

test('a huge plan is cut from the front to fit a comment', () => {
  const huge = `${'x'.repeat(200_000)}\nPlan: 9 to add, 0 to change, 0 to destroy.`
  const body = formatComment([plan('tofu', 'planned', huge), plan('aws/live', 'planned', 'No changes.')], 'a'.repeat(40))
  assert.ok(body.length < 65_536)
  assert.match(body, /characters cut/)
  assert.match(body, /Plan: 9 to add/)
})

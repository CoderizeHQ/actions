// The notification email: what deploy-preview and release send to ops@, and that it always goes from the one address
// to the one recipient with the configuration set (what coderizehq-notify-send allows).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { clean, CONFIGURATION_SET, FROM, message, NOTIFY_ROLE_ARN, notify, parseResults, TO } from './notify.mjs'

const base = {
  site: 'sbmcdn-com',
  repo: 'CoderizeHQ/gate-test-web',
  commit: 'a'.repeat(40),
  runUrl: 'https://github.com/CoderizeHQ/gate-test-web/actions/runs/1',
}

test('a failed deploy-preview names the site, the commit, each job and the run', () => {
  const m = message({ ...base, workflow: 'deploy-preview', ref: 'refs/heads/main', results: 'build=success,deploy=failure' })
  assert.equal(m.ok, false)
  assert.equal(m.subject, '[CoderizeHQ] deploy-preview failed: sbmcdn-com aaaaaaa')
  assert.match(m.text, /^Jobs: {4}build success, deploy failure$/m)
  assert.match(m.text, /^Commit: {2}a{40}$/m)
  assert.match(m.text, /actions\/runs\/1$/m)
})

test('a successful release names the version, the live URL and the approval', () => {
  const m = message({
    ...base,
    workflow: 'release',
    ref: 'refs/tags/v1.4.0',
    results: 'verify=success,publish=success',
    kind: 'version',
    releasePr: '9',
    approver: 'GilbertJames',
    siteUrl: 'https://sbmcdn.com',
  })
  assert.equal(m.ok, true)
  assert.equal(m.subject, '[CoderizeHQ] released sbmcdn-com v1.4.0')
  assert.match(m.text, /^Live: {4}https:\/\/sbmcdn\.com$/m)
  assert.match(m.text, /^Release: PR #9, approved by GilbertJames$/m)
})

test('a refused release says why', () => {
  const m = message({
    ...base,
    workflow: 'release',
    ref: 'refs/tags/v0.0.0',
    results: 'verify=failure,publish=skipped',
    reasons: 'no GitHub release for this tag; the commit is not the merge of a pull request',
  })
  assert.equal(m.ok, false)
  assert.equal(m.subject, '[CoderizeHQ] release failed: sbmcdn-com v0.0.0')
  assert.match(m.text, /^Refused: no GitHub release for this tag; the commit is not the merge of a pull request$/m)
})

test('the weekly dependency run is named as such, with its Renovate PRs', () => {
  const ok = message({ ...base, workflow: 'release', ref: 'refs/heads/main', results: 'verify=success,publish=success', kind: 'dependency', dependencyPrs: '3,4' })
  assert.equal(ok.subject, '[CoderizeHQ] released sbmcdn-com weekly dependency run')
  assert.match(ok.text, /^Release: dependency-only, Renovate PRs #3, #4$/m)
  const left = message({ ...base, workflow: 'release', ref: 'refs/heads/main', results: 'verify=failure,publish=skipped', reasons: 'x; dependency-only release left for James' })
  assert.equal(left.subject, '[CoderizeHQ] release failed: sbmcdn-com weekly dependency run')
})

test('a cancelled job counts as a failure', () => {
  assert.equal(message({ ...base, workflow: 'release', ref: 'refs/tags/v1.0.0', results: 'verify=success,publish=cancelled' }).ok, false)
})

test('values from the run cannot add lines or headers', () => {
  const m = message({ ...base, workflow: 'release', ref: 'refs/tags/v1\r\nBcc: evil@example.com', results: 'verify=failure,publish=skipped' })
  assert.doesNotMatch(m.subject, /[\r\n]/)
  assert.doesNotMatch(m.text, /^Bcc:/m)
  assert.equal(clean('a\u0000b\u007fc\n d'), 'a b c d')
  assert.equal(clean('x'.repeat(500), 10), 'x'.repeat(10))
})

test('refuses an unknown workflow or a malformed result list', () => {
  assert.throws(() => message({ ...base, workflow: 'other', ref: 'refs/heads/main', results: 'a=success' }), /unknown workflow/)
  assert.throws(() => parseResults('build=success;deploy=failure'), /job=result/)
  assert.deepEqual(parseResults('verify=success,publish='), [
    { job: 'verify', result: 'success' },
    { job: 'publish', result: 'unknown' },
  ])
})

test('always sends from notify@notify.coderize.dev to ops@ with the coderizehq-notify configuration set', async () => {
  const sent = []
  const mailer = { send: async (m) => (sent.push(m), 'msg-1') }
  const r = await notify({ ...base, workflow: 'deploy-preview', ref: 'refs/heads/main', results: 'build=failure,deploy=skipped' }, mailer)
  assert.equal(r.id, 'msg-1')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].from, FROM)
  assert.equal(FROM, 'CoderizeHQ <notify@notify.coderize.dev>')
  assert.equal(sent[0].to, TO)
  assert.equal(TO, 'ops@coderize.dev')
  assert.equal(sent[0].configurationSet, CONFIGURATION_SET)
  assert.equal(CONFIGURATION_SET, 'coderizehq-notify')
})

test('the role ARN is the fixed live-account notify role', () => {
  assert.equal(NOTIFY_ROLE_ARN, 'arn:aws:iam::243891826043:role/coderizehq-notify-send')
})

test("a go-live release is named as such, and says it went to the new distribution before the alias move", () => {
  const ok = message({ ...base, workflow: 'release', ref: 'refs/heads/main', results: 'verify=success,publish=success', kind: 'go-live', siteUrl: 'https://d111111abcdef8.cloudfront.net' })
  assert.equal(ok.subject, '[CoderizeHQ] released sbmcdn-com go-live release')
  assert.match(ok.text, /^Release: go-live, main's head on the new distribution before its alias move \(platform's apply\)$/m)
})

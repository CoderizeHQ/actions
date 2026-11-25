// The notification email: what deploy-preview and release send to ops@, and that it always goes from the one address
// to the one recipient with the configuration set (what coderizehq-notify-send allows).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  clean,
  CONFIGURATION_SET,
  cronSlot,
  decide,
  emailed,
  FROM,
  isWeeklyRun,
  message,
  NOTIFY_ROLE_ARN,
  notify,
  parseResults,
  repeatCandidates,
  shouldEmail,
  TO,
} from './notify.mjs'

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
  assert.equal(ok.subject, '[CoderizeHQ] released sbmcdn-com (go-live)')
  assert.match(ok.text, /^Release: go-live, main's head on the new distribution before its alias move \(platform's apply\)$/m)
})

test("a data refresh's email says so, with the commit it refreshed (not main's head)", () => {
  const m = message({ ...base, workflow: 'release', ref: 'refs/heads/main', kind: 'refresh', results: 'verify=success,publish=success', siteUrl: 'https://sbmcdn.com' })
  assert.equal(m.subject, '[CoderizeHQ] released sbmcdn-com data refresh of aaaaaaa')
  assert.match(m.text, /^Release: data refresh, the commit live runs now built again with its feed's secrets/m)
  const failed = message({ ...base, workflow: 'release', ref: 'refs/heads/main', kind: 'refresh', results: 'verify=failure,publish=skipped', reasons: "the refresh's build and store didn't both succeed (build=failure,store=skipped)" })
  assert.equal(failed.subject, '[CoderizeHQ] release failed: sbmcdn-com data refresh of aaaaaaa')
})

test("a content rebuild's email says so, with the commit it rebuilt (not main's head)", () => {
  const m = message({ ...base, workflow: 'release', ref: 'refs/heads/main', kind: 'content', results: 'verify=success,publish=success', siteUrl: 'https://sbmcdn.com' })
  assert.equal(m.subject, '[CoderizeHQ] released sbmcdn-com content rebuild of aaaaaaa')
  assert.match(m.text, /^Release: content rebuild, the commit live runs now built again because its content changed/m)
})

// --- Whether a release run emails: holds and the backup cron's repeats (shouldEmail, decide) ---

const slotRun = (over = {}) => ({
  id: 10,
  event: 'repository_dispatch',
  triggering_actor: { login: 'coderizehq-release[bot]' },
  head_branch: 'main',
  head_sha: 'a'.repeat(40),
  created_at: '2026-11-24T09:41:00Z',
  status: 'completed',
  conclusion: 'success',
  ...over,
})
const cronRun = { id: 11, workflow_id: 77, created_at: '2026-11-24T20:20:00Z', head_sha: 'a'.repeat(40) }
const weekly = { event: 'repository_dispatch', dispatch: 'weekly-dependency-release', sender: 'coderizehq-release[bot]' }

test('a weekly run held for James emails nothing; a hand-started one, a real failure or another event still emails', () => {
  assert.equal(shouldEmail({ ...weekly, hold: 'true' }).send, false)
  assert.match(shouldEmail({ ...weekly, hold: 'true' }).why, /weekly digest/)
  assert.equal(shouldEmail({ event: 'schedule', hold: 'true' }).send, false)
  // James's hand start, someone else's dispatch, a go-live release: not the weekly run, so the hold still emails.
  assert.equal(shouldEmail({ event: 'workflow_dispatch', hold: 'true' }).send, true)
  assert.equal(shouldEmail({ ...weekly, sender: 'someone', hold: 'true' }).send, true)
  assert.equal(shouldEmail({ ...weekly, dispatch: 'go-live-release', hold: 'true' }).send, true)
  // Not a hold: a publish error, a verify error other than the hold, an infrastructure failure.
  assert.equal(shouldEmail({ ...weekly, hold: '' }).send, true)
  assert.equal(shouldEmail({ event: 'schedule', hold: undefined }).send, true)
  assert.equal(shouldEmail({ event: 'push', hold: '' }).send, true)
})

test("isWeeklyRun: the cron, or the release App's weekly-dependency-release dispatch", () => {
  assert.equal(isWeeklyRun({ event: 'schedule' }), true)
  assert.equal(isWeeklyRun(weekly), true)
  assert.equal(isWeeklyRun({ ...weekly, sender: 'coderizehq-platform[bot]' }), false)
  assert.equal(isWeeklyRun({ event: 'workflow_dispatch' }), false)
  assert.equal(isWeeklyRun({ event: 'push' }), false)
})

test("cronSlot: the latest time a weekly 'm h * * d' cron named at or before the run; any other form is null", () => {
  assert.equal(cronSlot('37 9 * * 2', new Date('2026-11-24T20:20:00Z')).toISOString(), '2026-11-24T09:37:00.000Z')
  assert.equal(cronSlot('37 9 * * 2', new Date('2026-11-24T09:37:00Z')).toISOString(), '2026-11-24T09:37:00.000Z')
  assert.equal(cronSlot('37 9 * * 2', new Date('2026-11-24T09:36:59Z')).toISOString(), '2026-11-17T09:37:00.000Z')
  // A cron GitHub fires a day late still belongs to Tuesday's slot.
  assert.equal(cronSlot('37 9 * * 2', new Date('2026-11-25T03:00:00Z')).toISOString(), '2026-11-24T09:37:00.000Z')
  assert.equal(cronSlot('0 0 * * 7', new Date('2026-11-25T03:00:00Z')).toISOString(), '2026-11-22T00:00:00.000Z')
  for (const cron of ['*/5 * * * *', '37 9 * * 1-5', '37 9 1 * 2', '', undefined, '61 9 * * 2']) {
    assert.equal(cronSlot(cron, new Date('2026-11-24T20:20:00Z')), null, String(cron))
  }
})

test("repeatCandidates: this slot's earlier weekly runs on main for the same commit with the same result, newest first", () => {
  const slot = new Date('2026-11-24T09:37:00Z')
  const runs = [slotRun(), { ...cronRun, event: 'schedule', status: 'in_progress', conclusion: null }]
  assert.deepEqual(repeatCandidates({ run: cronRun, runs, slot, ok: true }).map((r) => r.id), [10])
  // The dispatch failed and the cron failed too (whether the dispatch emailed is decide's question).
  assert.deepEqual(repeatCandidates({ run: cronRun, runs: [slotRun({ conclusion: 'failure' })], slot, ok: false }).map((r) => r.id), [10])
  // James's hand start in the slot counts too.
  assert.deepEqual(repeatCandidates({ run: cronRun, runs: [slotRun({ event: 'workflow_dispatch', triggering_actor: { login: 'GilbertJames' } })], slot, ok: true }).map((r) => r.id), [10])
  const two = [slotRun(), slotRun({ id: 9, created_at: '2026-11-24T12:00:00Z', event: 'workflow_dispatch' })]
  assert.deepEqual(repeatCandidates({ run: cronRun, runs: two, slot, ok: true }).map((r) => r.id), [9, 10])
})

test("repeatCandidates: a new commit, another result, last week, an unfinished or skipped run, or a stranger's dispatch is no repeat", () => {
  const slot = new Date('2026-11-24T09:37:00Z')
  const none = (over, ok = true) => assert.deepEqual(repeatCandidates({ run: cronRun, runs: [slotRun(over)], slot, ok }), [], JSON.stringify(over))
  none({ head_sha: 'b'.repeat(40) })
  none({ conclusion: 'failure' })
  none({}, false)
  none({ created_at: '2026-11-24T09:30:00Z' })
  none({ created_at: '2026-11-24T21:00:00Z' })
  none({ status: 'in_progress', conclusion: null })
  none({ conclusion: 'skipped' })
  none({ conclusion: 'cancelled' })
  none({ triggering_actor: { login: 'someone' } })
  none({ head_branch: 'feature/x' })
  none({ event: 'push' })
  none({ id: 11 })
})

const notifyJob = (conclusion, name = 'release / notify') => ({ name, steps: [{ name: 'Decide whether to email', conclusion: 'success' }, { name: 'Email ops@', conclusion }] })

test("emailed: only a notify job whose 'Email ops@' step succeeded", () => {
  assert.equal(emailed([{ name: 'release / verify', steps: [] }, notifyJob('success')]), true)
  assert.equal(emailed([notifyJob('success', 'notify')]), true)
  assert.equal(emailed([notifyJob('skipped')]), false)
  assert.equal(emailed([notifyJob('failure')]), false)
  assert.equal(emailed([{ name: 'release / verify', steps: [{ name: 'Email ops@', conclusion: 'success' }] }]), false)
  assert.equal(emailed([]), false)
  assert.equal(emailed(undefined), false)
})

test('decide: only a cron run is looked up; it finds the slot from the cron, the runs since, and whether that run emailed', async () => {
  const calls = []
  const fake = (jobs) => ({
    get: async (p) => (calls.push(p), p.includes('/jobs') ? { jobs } : cronRun),
    all: async (p, pick) => (calls.push(p), pick({ workflow_runs: [slotRun(), { ...cronRun, event: 'schedule' }] })),
  })
  const env = { EVENT: 'schedule', SCHEDULE: '37 9 * * 2', REPO: 'CoderizeHQ/gate-test-web', RUN_ID: '11', HOLD: '', RESULTS: 'verify=success,publish=success' }
  const d = await decide(env, fake([notifyJob('success')]))
  assert.equal(d.send, false)
  assert.match(d.why, /repeated run 10/)
  assert.deepEqual(calls, [
    '/repos/CoderizeHQ/gate-test-web/actions/runs/11',
    '/repos/CoderizeHQ/gate-test-web/actions/workflows/77/runs?branch=main&created=%3E%3D2026-11-24T09%3A37%3A00.000Z',
    '/repos/CoderizeHQ/gate-test-web/actions/runs/10/jobs?filter=latest&per_page=100',
  ])
  // The cron's publish failed where the dispatch succeeded: that is news, so it emails.
  assert.equal((await decide({ ...env, RESULTS: 'verify=success,publish=failure' }, fake([notifyJob('success')]))).send, true)
  // Not a cron run, or a held weekly run: nothing to look up.
  const never = { get: async () => assert.fail('no lookup'), all: async () => assert.fail('no lookup') }
  assert.equal((await decide({ ...env, EVENT: 'repository_dispatch', DISPATCH: 'weekly-dependency-release', SENDER: 'coderizehq-release[bot]' }, never)).send, true)
  assert.equal((await decide({ ...env, HOLD: 'true' }, never)).send, false)
  assert.equal((await decide({ ...env, EVENT: 'push' }, never)).send, true)
  // A cron that isn't weekly is never a repeat.
  assert.equal((await decide({ ...env, SCHEDULE: '*/5 * * * *' }, { ...never, get: async () => cronRun })).send, true)
})

test('decide: a cron run failing after a held dispatch (which emailed nothing) still emails its real failure', async () => {
  const held = { name: 'release / notify', steps: [{ name: 'Decide whether to email', conclusion: 'success' }, { name: 'Email ops@', conclusion: 'skipped' }] }
  const api = {
    get: async (p) => (p.includes('/jobs') ? { jobs: [{ name: 'release / verify', conclusion: 'failure', steps: [] }, held] } : cronRun),
    all: async (p, pick) => pick({ workflow_runs: [slotRun({ conclusion: 'failure' })] }),
  }
  // An API error in verify, so not a hold: same commit, same failure conclusion as the held dispatch.
  const env = { EVENT: 'schedule', SCHEDULE: '37 9 * * 2', REPO: 'CoderizeHQ/gate-test-web', RUN_ID: '11', HOLD: '', RESULTS: 'verify=failure,publish=skipped' }
  const d = await decide(env, api)
  assert.equal(d.send, true)
  // A hold on that cron run is still silent (the digest has it).
  assert.equal((await decide({ ...env, HOLD: 'true' }, api)).send, false)
})

test("release.yml's notify decides before any AWS, and installs, assumes the role and sends only when it should", async () => {
  const { readFileSync } = await import('node:fs')
  const wf = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.match(wf, /\n {6}hold: \$\{\{ steps\.verify\.outputs\.hold \}\}\n/)
  const job = wf.slice(wf.indexOf('\n  notify:'))
  const decideAt = job.indexOf('- name: Decide whether to email')
  assert.ok(decideAt > 0 && decideAt < job.indexOf('pnpm install') && decideAt < job.indexOf('configure-aws-credentials'))
  const decideStep = job.slice(decideAt, job.indexOf('notify.mjs decide'))
  for (const line of ['HOLD: ${{ needs.verify.outputs.hold }}', 'EVENT: ${{ github.event_name }}', 'DISPATCH: ${{ github.event.action }}', 'SENDER: ${{ github.event.sender.login }}', 'SCHEDULE: ${{ github.event.schedule }}']) {
    assert.ok(decideStep.includes(line), line)
  }
  assert.equal(job.match(/if: steps\.decide\.outputs\.send == 'true'/g)?.length, 3)
  assert.match(job, /if: steps\.decide\.outputs\.send == 'true'\n\s+with:\n\s+role-to-assume: arn:aws:iam::243891826043:role\/coderizehq-notify-send\n/)
})

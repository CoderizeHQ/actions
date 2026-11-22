import assert from 'node:assert/strict'
import { test } from 'node:test'

import { differences, kindOf, parseSts, probe, targets, tryAssume } from './trustProbe.mjs'

const SITES = [
  { site: 'sbmcdn-com', repo: 'gate-test-web', repo_id: 1458015532, account: 'live' },
  { site: 'preview-only-com', repo: 'preview-only-web', repo_id: 1460000009, account: 'client' },
]

// The token a platform PR's ci-tofu job gets.
const PR_CLAIMS = {
  repository: 'CoderizeHQ/platform',
  repository_id: '1457774113',
  event_name: 'pull_request',
  ref: 'refs/pull/20/merge',
  job_workflow_ref: 'CoderizeHQ/actions/.github/workflows/ci-tofu.yml@refs/tags/v1',
  sub: 'repo:CoderizeHQ@356609590/platform@1457774113:pull_request',
}

test('every site gets a preview role, live sites a publish role, each account its deploy role', () => {
  assert.deepEqual(targets(SITES).map((t) => t.arn), [
    'arn:aws:iam::798070830797:role/coderizehq-preview-deploy-sbmcdn-com',
    'arn:aws:iam::243891826043:role/coderizehq-live-publish-sbmcdn-com',
    'arn:aws:iam::798070830797:role/coderizehq-preview-deploy-preview-only-com',
    'arn:aws:iam::798070830797:role/coderizehq-infra-deploy',
    'arn:aws:iam::243891826043:role/coderizehq-infra-deploy',
  ])
})

test('a preview-only live-account record ("live": false) gets its preview role, not a publish role', () => {
  const arns = targets([{ site: 'moving-in-com', repo: 'moving-in-com-web', repo_id: 1460000010, account: 'live', live: false }]).map((t) => t.arn)
  assert.ok(arns.includes('arn:aws:iam::798070830797:role/coderizehq-preview-deploy-moving-in-com'))
  assert.ok(!arns.some((a) => a.includes('live-publish')))
})

test('a live-account record with "live": true, or without the field, still gets its publish role', () => {
  for (const extra of [{ live: true }, {}]) {
    const arns = targets([{ site: 'live-com', repo: 'live-com-web', repo_id: 1460000011, account: 'live', ...extra }]).map((t) => t.arn)
    assert.ok(arns.includes('arn:aws:iam::243891826043:role/coderizehq-live-publish-live-com'))
  }
})

test("a site with data refreshes has its preview role trust version tags too, where its release stores its refresh", () => {
  const [plain] = targets([{ site: 'a-com', repo: 'a-com-web', repo_id: 1, account: 'live' }])
  const [refresh] = targets([{ site: 'b-com', repo: 'b-com-web', repo_id: 2, account: 'live', refresh: { every: '3h', secrets: ['A_B'] } }])
  assert.deepEqual(plain.trusted.refs, ['refs/heads/main'])
  assert.deepEqual(refresh.trusted.refs, ['refs/heads/main', 'refs/tags/v*'])
  assert.match(differences({ ...PR_CLAIMS, repository_id: '2' }, refresh.trusted).at(-1), /not refs\/heads\/main or refs\/tags\/v\*/)
})

test("a platform PR's token differs from each role's trust in the ways the README lists", () => {
  const [preview, live, , deploy] = targets(SITES)
  assert.deepEqual(differences(PR_CLAIMS, preview.trusted), [
    'another repository (CoderizeHQ/platform, not gate-test-web)',
    'another workflow file (CoderizeHQ/actions/.github/workflows/ci-tofu.yml@refs/tags/v1)',
    'the ref refs/pull/20/merge, not refs/heads/main',
  ])
  assert.deepEqual(differences(PR_CLAIMS, live.trusted), [
    'another repository (CoderizeHQ/platform, not gate-test-web)',
    'another workflow file (CoderizeHQ/actions/.github/workflows/ci-tofu.yml@refs/tags/v1)',
    'not the release environment',
    'the ref refs/pull/20/merge, not refs/tags/v* or refs/heads/main',
  ])
  // Same repository: refused for the workflow file, the environment and the ref alone.
  assert.deepEqual(differences(PR_CLAIMS, deploy.trusted), [
    'another workflow file (CoderizeHQ/actions/.github/workflows/ci-tofu.yml@refs/tags/v1)',
    'not the apply environment',
    'the ref refs/pull/20/merge, not refs/heads/main',
  ])
  // The claims each role does trust differ in nothing.
  const releaseRun = { repository_id: '1458015532', job_workflow_ref: 'CoderizeHQ/actions/.github/workflows/release.yml@refs/tags/v1.2.0', environment: 'release', ref: 'refs/tags/v0.3.0' }
  assert.deepEqual(differences(releaseRun, live.trusted), [])
  assert.match(differences({ ...releaseRun, job_workflow_ref: 'CoderizeHQ/actions/.github/workflows/release.yml@refs/tags/v10' }, live.trusted)[0], /another workflow file/)
})

test("STS's answers are read from its XML", () => {
  assert.deepEqual(parseSts(200, '<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>'), { assumed: true })
  assert.deepEqual(parseSts(403, '<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>Not authorized to perform sts:AssumeRoleWithWebIdentity</Message></Error></ErrorResponse>'), {
    assumed: false,
    code: 'AccessDenied',
    message: 'Not authorized to perform sts:AssumeRoleWithWebIdentity',
  })
  assert.equal(parseSts(502, 'bad gateway').code, 'HTTP 502')
})

test('the STS call is unsigned and carries only the role, a session name and the token', async () => {
  let sent
  const fetchImpl = async (url, init) => {
    sent = { url, init }
    return { status: 403, text: async () => '<Error><Code>AccessDenied</Code><Message>no</Message></Error>' }
  }
  const r = await tryAssume('arn:aws:iam::1:role/x', 'jwt', fetchImpl)
  assert.equal(r.code, 'AccessDenied')
  assert.equal(sent.url, 'https://sts.us-east-1.amazonaws.com/')
  assert.equal(sent.init.headers.authorization, undefined)
  const body = new URLSearchParams(sent.init.body)
  assert.equal(body.get('Action'), 'AssumeRoleWithWebIdentity')
  assert.equal(body.get('RoleArn'), 'arn:aws:iam::1:role/x')
  assert.equal(body.get('WebIdentityToken'), 'jwt')
})

// A fake STS: the control role is assumed, everything else refused, unless the test says otherwise.
const fakeAssume = (overrides = {}) => async (arn) => {
  const role = arn.split('/').at(-1)
  if (overrides[arn]) return overrides[arn]
  return role === 'coderizehq-infra-plan' ? { assumed: true } : { assumed: false, code: 'AccessDenied', message: 'Not authorized' }
}
const allExist = async () => true

test('passes when the control is assumed and every other role refuses an existing role', async () => {
  const { rows, problems } = await probe({ claims: PR_CLAIMS, token: 'jwt', sites: SITES, assume: fakeAssume(), roleExists: allExist })
  assert.deepEqual(problems, [])
  assert.equal(rows.length, 7)
  assert.equal(rows.filter((r) => r.result === 'AccessDenied').length, 5)
})

test('fails on an assumed role, another error, a missing role, or a failed control', async () => {
  const assumed = await probe({
    claims: PR_CLAIMS,
    token: 'jwt',
    sites: SITES,
    assume: fakeAssume({ 'arn:aws:iam::243891826043:role/coderizehq-live-publish-sbmcdn-com': { assumed: true } }),
    roleExists: allExist,
  })
  assert.match(assumed.problems.join('\n'), /coderizehq-live-publish-sbmcdn-com in 243891826043 was assumed/)

  const otherError = await probe({
    claims: PR_CLAIMS,
    token: 'jwt',
    sites: SITES,
    assume: fakeAssume({ 'arn:aws:iam::798070830797:role/coderizehq-infra-deploy': { assumed: false, code: 'InvalidIdentityToken', message: 'expired' } }),
    roleExists: allExist,
  })
  assert.match(otherError.problems.join('\n'), /answered InvalidIdentityToken/)

  const noDeploy = await probe({ claims: PR_CLAIMS, token: 'jwt', sites: SITES, assume: fakeAssume(), roleExists: async (account, role) => !(account === '243891826043' && role === 'coderizehq-infra-deploy') })
  assert.deepEqual(noDeploy.problems, ["coderizehq-infra-deploy doesn't exist in 243891826043, so its refusal proves nothing"])

  const noControl = await probe({
    claims: PR_CLAIMS,
    token: 'jwt',
    sites: SITES,
    assume: fakeAssume({ 'arn:aws:iam::798070830797:role/coderizehq-infra-plan': { assumed: false, code: 'AccessDenied', message: 'no' } }),
    roleExists: allExist,
  })
  assert.match(noControl.problems[0], /the control failed: coderizehq-infra-plan in 798070830797/)
})

// A record merged before its apply names roles only that apply makes (platform, 2026-11-20: two new preview-only
// sites' preview roles failed every platform PR until the next apply, which was waiting on one of those PRs).
test("a site role that isn't made yet is a warning, not a failure, while others of its kind exist and refuse", async () => {
  const sites = [...SITES, { site: 'new-com', repo: 'new-com-mono', repo_id: 1460000012, account: 'live', live: false }]
  const r = await probe({ claims: PR_CLAIMS, token: 'jwt', sites, assume: fakeAssume(), roleExists: async (account, role) => role !== 'coderizehq-preview-deploy-new-com' })
  assert.deepEqual(r.problems, [])
  assert.deepEqual(r.warnings, ["coderizehq-preview-deploy-new-com doesn't exist in 798070830797 yet (the next apply makes it), so nothing was proved about it; the first PR after that apply probes it"])
  assert.equal(r.rows.find((x) => x.role === 'coderizehq-preview-deploy-new-com').result, 'not made yet')
})

test('every role of one kind missing in an account fails: that is what a wrong role name looks like', async () => {
  const r = await probe({ claims: PR_CLAIMS, token: 'jwt', sites: SITES, assume: fakeAssume(), roleExists: async (account, role) => !role.startsWith('coderizehq-preview-deploy-') })
  assert.deepEqual(r.problems, ['none of the 2 coderizehq-preview-deploy-* roles exists in 798070830797, so no refusal of that kind proved anything: is the role name right?'])
  assert.equal(r.warnings.length, 2)
  const live = await probe({ claims: PR_CLAIMS, token: 'jwt', sites: SITES, assume: fakeAssume(), roleExists: async (account, role) => role !== 'coderizehq-live-publish-sbmcdn-com' })
  assert.match(live.problems.join('\n'), /none of the 1 coderizehq-live-publish-\* roles exists in 243891826043/)
})

test("a missing role that STS didn't refuse with AccessDenied, or that was assumed, still fails as before", async () => {
  const r = await probe({
    claims: PR_CLAIMS,
    token: 'jwt',
    sites: SITES,
    assume: fakeAssume({ 'arn:aws:iam::243891826043:role/coderizehq-live-publish-sbmcdn-com': { assumed: true } }),
    roleExists: async () => false,
  })
  assert.match(r.problems.join('\n'), /coderizehq-live-publish-sbmcdn-com in 243891826043 was assumed/)
})

test('kinds are the role name without its site', () => {
  assert.equal(kindOf('coderizehq-preview-deploy-a-com'), 'coderizehq-preview-deploy')
  assert.equal(kindOf('coderizehq-live-publish-a-com'), 'coderizehq-live-publish')
  assert.equal(kindOf('coderizehq-infra-deploy'), 'coderizehq-infra-deploy')
})

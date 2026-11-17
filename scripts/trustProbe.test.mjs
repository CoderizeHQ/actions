import assert from 'node:assert/strict'
import { test } from 'node:test'

import { differences, parseSts, probe, targets, tryAssume } from './trustProbe.mjs'

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

  const missing = await probe({ claims: PR_CLAIMS, token: 'jwt', sites: SITES, assume: fakeAssume(), roleExists: async (account, role) => role !== 'coderizehq-preview-deploy-sbmcdn-com' })
  assert.deepEqual(missing.problems, ["coderizehq-preview-deploy-sbmcdn-com doesn't exist in 798070830797, so its refusal proves nothing"])

  const noControl = await probe({
    claims: PR_CLAIMS,
    token: 'jwt',
    sites: SITES,
    assume: fakeAssume({ 'arn:aws:iam::798070830797:role/coderizehq-infra-plan': { assumed: false, code: 'AccessDenied', message: 'no' } }),
    roleExists: allExist,
  })
  assert.match(noControl.problems[0], /the control failed: coderizehq-infra-plan in 798070830797/)
})

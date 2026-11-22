// Content rebuilds (lib/rebuild.mjs, rebuild-target.yml): GitHub's answers stubbed.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { CONTENT_REBUILD, describeTarget, dispatchProblems, findTarget } from './lib/rebuild.mjs'
import { target } from './rebuild.mjs'

const site = 'sbmcdn-com'
const repo = 'CoderizeHQ/sbmcdn-com-web'
const live = '1'.repeat(40)
const content = 'c'.repeat(64)
const dispatch = { ref: 'refs/heads/main', sender: 'coderizehq-release[bot]', site, payloadSite: site, payloadContent: content }

// The facts findTarget reads, stubbed: what's live, the version tag on it, and the two release checks.
function facts({ deployment = { id: 1, sha: live, kind: 'version' }, tag = 'v1.4.0', release = { ok: true, reasons: [], sha: live, pr: 12, approver: 'GilbertJames' }, dependency = null } = {}) {
  const asked = []
  return {
    asked,
    read: {
      liveDeployment: async (_t, r, env) => (asked.push(['live', r, env]), deployment),
      versionTagAt: async (_t, r, sha) => (asked.push(['tag', sha]), tag),
    },
    checks: {
      checkRelease: async (_t, r, ref) => (asked.push(['release', ref]), release),
      checkDependencyRun: async (_t, r, sha) => (asked.push(['dependency', sha]), dependency ?? assert.fail('no dependency check expected')),
    },
  }
}

test('the dispatch: on main, from the release App, naming this site, with a content hash', () => {
  assert.deepEqual(dispatchProblems(dispatch), [])
  assert.deepEqual(CONTENT_REBUILD.senders, ['coderizehq-release[bot]'])
  assert.match(dispatchProblems({ ...dispatch, ref: 'refs/tags/v1.0.0' })[0], /only on main, not refs\/tags\/v1\.0\.0/)
  // Not the platform App (its go-live release is another dispatch), not a person, not Renovate.
  for (const sender of ['coderizehq-platform[bot]', 'GilbertJames', 'coderizehq-renovate[bot]', '']) {
    assert.match(dispatchProblems({ ...dispatch, sender }).join(' '), /comes only from platform's content check/, sender)
  }
  assert.match(dispatchProblems({ ...dispatch, payloadSite: 'other-com' })[0], /names other-com, not sbmcdn-com/)
  assert.match(dispatchProblems({ ...dispatch, payloadContent: 'abc' })[0], /isn't a SHA-256/)
  assert.match(dispatchProblems({ ...dispatch, payloadContent: undefined })[0], /\(none\) isn't a SHA-256/)
})

test("the dispatch's fields are shown tamed, so they can't add lines or workflow commands", () => {
  for (const r of dispatchProblems({ ...dispatch, sender: 'x\n::error::fake', payloadSite: 'a\n## injected', payloadContent: '%0A::warning::' })) {
    assert.doesNotMatch(r, /\n|::error::|::warning::|##/)
  }
})

test('the target is the live commit when it is an approved version release', async () => {
  const f = facts()
  const t = await findTarget({ token: 't', repo, environment: 'live', ...f })
  assert.deepEqual(t, { ok: true, sha: live, basis: 'version', tag: 'v1.4.0', pr: 12, approver: 'GilbertJames', prs: [] })
  assert.deepEqual(f.asked, [['live', repo, 'live'], ['tag', live], ['release', 'refs/tags/v1.4.0']])
})

test("a package site reads its own deployments (live-<site>), and a content rebuild already live is rebuilt as the release it is", async () => {
  const f = facts({ deployment: { id: 2, sha: live, kind: 'content' } })
  const t = await findTarget({ token: 't', repo, environment: 'live-admin-example-com', ...f })
  assert.equal(t.ok, true)
  assert.deepEqual(f.asked[0], ['live', repo, 'live-admin-example-com'])
})

test('a dependency-only release on top of a version release is rebuilt, re-checked as a dependency gap', async () => {
  const f = facts({ tag: null, deployment: { id: 3, sha: live, kind: 'dependency' }, dependency: { ok: true, nothing: false, reasons: [], prs: [7, 8], base: { sha: '2'.repeat(40), tag: 'v1.4.0' } } })
  assert.deepEqual(await findTarget({ token: 't', repo, environment: 'live', ...f }), { ok: true, sha: live, basis: 'dependency', tag: 'v1.4.0', pr: null, approver: null, prs: [7, 8] })
})

test('refused: nothing live, a go-live release, an unknown kind, a tag that no longer passes, a commit no release names', async () => {
  const run = (o) => findTarget({ token: 't', repo, environment: 'live', ...facts(o) })
  assert.match((await run({ deployment: null })).reasons[0], /nothing is live \(no successful deployment to live\)/)
  assert.match((await run({ deployment: { id: 1, sha: live, kind: 'go-live' } })).reasons[0], /go-live release .* content rebuilds start once a version release is live/)
  assert.match((await run({ deployment: { id: 1, sha: live, kind: 'manual' } })).reasons[0], /kind manual, not one release records/)
  assert.match((await run({ deployment: { id: 1, sha: live, kind: null } })).reasons[0], /kind \(none\)/)
  const unapproved = await run({ release: { ok: false, reasons: ['James did not approve the release PR at its head commit'], sha: live } })
  assert.equal(unapproved.ok, false)
  assert.deepEqual(unapproved.reasons, ['James did not approve the release PR at its head commit', 'live 1111111 (v1.4.0) no longer passes release-check'])
  const moved = await run({ release: { ok: true, reasons: [], sha: '9'.repeat(40) } })
  assert.match(moved.reasons.join(' '), /v1\.4\.0 points at 9{40}, not live 1{40}/)
  const stray = await run({ tag: null, dependency: { ok: false, nothing: false, reasons: ['#9 was not opened by Renovate'], prs: [9] } })
  assert.deepEqual(stray.reasons, ['#9 was not opened by Renovate', 'live 1111111 is neither an approved version release nor a dependency-only release on top of one'])
  // A commit with no tag and no gap at all (the dependency check says "nothing") isn't a release either.
  const nothing = await run({ tag: null, dependency: { ok: true, nothing: true, reasons: [], prs: [] } })
  assert.equal(nothing.ok, false)
})

test('target(): only the content-rebuild dispatch, checked, then the live commit', async () => {
  const found = { ok: true, sha: live, basis: 'version', tag: 'v1.4.0', pr: 12, approver: 'GilbertJames', prs: [] }
  const base = { token: 't', repo, event: 'repository_dispatch', dispatch: 'content-rebuild', environment: '', ...dispatch }
  const environments = []
  const find = async ({ environment }) => (environments.push(environment), found)
  assert.deepEqual(await target({ ...base, find }), { ok: true, sha: live, basis: 'version', tag: 'v1.4.0', contentSha256: content })
  assert.deepEqual(environments, ['live'])
  const never = async () => assert.fail('no lookup')
  assert.match((await target({ ...base, event: 'push', find: never })).reasons[0], /only for the repository_dispatch content-rebuild/)
  assert.match((await target({ ...base, dispatch: 'go-live-release', find: never })).reasons[0], /only for the repository_dispatch content-rebuild/)
  assert.equal((await target({ ...base, sender: 'someone', find: never })).ok, false)
  // Never another site's deployments.
  await assert.rejects(target({ ...base, environment: 'live-other-com', find: never }), /live or live-sbmcdn-com/)
})

test('describeTarget says what is rebuilt', () => {
  assert.equal(describeTarget({ sha: live, basis: 'version', tag: 'v1.4.0', contentSha256: content }), 'content rebuild of v1.4.0 (1111111), content cccccccccccc')
  assert.equal(describeTarget({ sha: live, basis: 'dependency', tag: 'v1.4.0', contentSha256: content }), 'content rebuild of the dependency-only release on v1.4.0 (1111111), content cccccccccccc')
})

test('rebuild-target.yml: read-only, no AWS, the event as environment only, and its commit as the output', () => {
  const wf = readFileSync(new URL('../.github/workflows/rebuild-target.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(wf, /id-token|configure-aws-credentials|: write/)
  assert.match(wf, /deployments: read/)
  assert.match(wf, /value: \$\{\{ jobs\.target\.outputs\.commit \}\}/)
  const step = wf.slice(wf.indexOf('- name: Find the commit to rebuild'))
  for (const line of ['DISPATCH: ${{ github.event.action }}', 'SENDER: ${{ github.event.sender.login }}', 'PAYLOAD_SITE: ${{ github.event.client_payload.site }}', 'PAYLOAD_CONTENT: ${{ github.event.client_payload.content_sha256 }}']) {
    assert.ok(step.includes(line), line)
  }
  for (const l of wf.split('\n')) if (/run: /.test(l)) assert.doesNotMatch(l, /github\.event\./, l)
})

test("deploy-preview.yml: rebuild-commit only for the content-rebuild dispatch on main, built in place of the run's commit, queued apart", () => {
  const wf = readFileSync(new URL('../.github/workflows/deploy-preview.yml', import.meta.url), 'utf8')
  assert.match(wf, /rebuild-commit:\n\s+description: .+\n\s+type: string\n\s+default: ''/)
  const check = wf.slice(wf.indexOf('- name: Check the content rebuild'), wf.indexOf('- name: Hash the lockfile'))
  assert.match(check, /if: inputs\.rebuild-commit != ''/)
  assert.match(check, /\[0-9a-f\]\{40\}/)
  assert.match(check, /\[ "\$EVENT" = repository_dispatch \] && \[ "\$DISPATCH" = content-rebuild \] && \[ "\$GITHUB_REF" = refs\/heads\/main \]/)
  // The check runs before the checkout, and the checkout (before anything from the site) takes the rebuild commit.
  assert.ok(check.indexOf('Check the content rebuild') < check.indexOf('actions/checkout'))
  assert.match(check, /ref: \$\{\{ inputs\.rebuild-commit \|\| github\.sha \}\}/)
  assert.match(wf, /group: deploy-preview-\$\{\{ inputs\.site \}\}\$\{\{ inputs\.refresh-lockfile-sha256 != '' && '-refresh' \|\| inputs\.rebuild-commit != '' && '-rebuild' \|\| '' \}\}/)
  const store = wf.slice(wf.indexOf('- name: Store the build and publish the preview'))
  assert.match(store, /COMMIT: \$\{\{ inputs\.rebuild-commit \|\| github\.sha \}\}/)
  assert.match(store, /RUN_SHA: \$\{\{ github\.sha \}\}/)
  assert.match(store, /REBUILD_RUN: \$\{\{ inputs\.rebuild-commit != '' && inputs\.refresh-lockfile-sha256 == '' && github\.run_id \|\| '' \}\}/)
  // The build job still asks for nothing: existing callers grant it nothing more.
  const build = wf.slice(wf.indexOf('\n  build:'), wf.indexOf('\n  deploy:'))
  assert.doesNotMatch(build, /permissions:/)
})

test('release.yml: verify reads deployments (within what callers grant), and publish takes the commit verify found', () => {
  const wf = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const verify = wf.slice(wf.indexOf('\n  verify:'), wf.indexOf('\n  publish:'))
  assert.match(verify, /deployments: read/)
  assert.match(verify, /commit: \$\{\{ steps\.verify\.outputs\.commit \}\}/)
  assert.match(verify, /PAYLOAD_CONTENT: \$\{\{ github\.event\.client_payload\.content_sha256 \}\}/)
  const publish = wf.slice(wf.indexOf('\n  publish:'), wf.indexOf('\n  notify:'))
  assert.match(publish, /COMMIT: \$\{\{ needs\.verify\.outputs\.commit \}\}/)
  assert.match(publish, /RUN_SHA: \$\{\{ github\.sha \}\}/)
  assert.match(publish, /REBUILD_RUN: \$\{\{ needs\.verify\.outputs\.kind == 'content' && github\.run_id \|\| '' \}\}/)
  assert.match(publish, /group: release-\$\{\{ inputs\.site \}\}\n/)
})

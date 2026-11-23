// Data refreshes (platform's `refresh` record field; README "Data refreshes"): the dispatch and target, release's
// verify and publish of a refresh, the stored refresh, and the workflows. GitHub stubbed, S3 in memory.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { storeBuild } from './deployPreview.mjs'
import { makeManifest, manifestKey, PREVIEW_BUCKET, readManifest, refreshPrefix, refreshRef, storedKey, storedPrefix } from './lib/build.mjs'
import { hashes } from './lib/files.mjs'
import { memoryStore } from './lib/memoryStore.mjs'
import { DATA_REFRESH, describeRefresh, findTarget, refreshDispatchProblems } from './lib/rebuild.mjs'
import { target } from './rebuild.mjs'
import { deploymentPayload, describe, KINDS, publishLive, REFRESH_RESULTS_OK, refreshRefusal, verify } from './release.mjs'

const site = 'lapeerrealty-com'
const repo = 'CoderizeHQ/lapeerrealty-com-mono'
const live = '1'.repeat(40)
const head = '2'.repeat(40)
const run = '5151'
const dispatch = { ref: 'refs/heads/main', sender: 'coderizehq-release[bot]', site, payloadSite: site, payloadReason: 'due' }
const workflow = (name) => readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')

function facts({ deployment = { id: 1, sha: live, kind: 'version' }, tag = 'v1.4.0', release = { ok: true, reasons: [], sha: live, pr: 12, approver: 'GilbertJames' }, dependency = null } = {}) {
  return {
    read: { liveDeployment: async () => deployment, versionTagAt: async () => tag },
    checks: {
      checkRelease: async () => release,
      checkDependencyRun: async () => dependency ?? { ok: false, nothing: false, reasons: ['not a dependency gap'], prs: [] },
    },
  }
}

test('the dispatch: on main, from the release App, naming this site, with a known reason', () => {
  assert.deepEqual(refreshDispatchProblems(dispatch), [])
  assert.deepEqual(DATA_REFRESH, { action: 'data-refresh', senders: ['coderizehq-release[bot]'], reasons: ['first', 'after-release', 'due'] })
  for (const reason of DATA_REFRESH.reasons) assert.deepEqual(refreshDispatchProblems({ ...dispatch, payloadReason: reason }), [])
  assert.match(refreshDispatchProblems({ ...dispatch, ref: 'refs/tags/v1.0.0' })[0], /only on main/)
  for (const sender of ['coderizehq-platform[bot]', 'GilbertJames', 'github-actions[bot]', '']) {
    assert.match(refreshDispatchProblems({ ...dispatch, sender }).join(' '), /comes only from platform's refresh check/, sender)
  }
  assert.match(refreshDispatchProblems({ ...dispatch, payloadSite: 'other-com' })[0], /names other-com, not lapeerrealty-com/)
  assert.match(refreshDispatchProblems({ ...dispatch, payloadReason: 'because\n::error::x' })[0], /reason because\?\?\?error\?\?x isn't one of/)
})

test('the target: the live commit as an approved release, a refresh or a go-live release whose commit is one', async () => {
  const find = (o) => findTarget({ token: 't', repo, environment: 'live-lapeerrealty-com', refresh: true, ...facts(o) })
  assert.deepEqual(await find(), { ok: true, sha: live, basis: 'version', tag: 'v1.4.0', pr: 12, approver: 'GilbertJames', prs: [] })
  assert.equal((await find({ deployment: { id: 2, sha: live, kind: 'refresh' } })).ok, true)
  // An alias move: the go-live release published a tagged, approved commit, so it's refreshed.
  assert.equal((await find({ deployment: { id: 3, sha: live, kind: 'go-live' } })).ok, true)
  // A go-live release of a main head no release names: refused, so unapproved code never gets the secrets.
  const unreleased = await find({ deployment: { id: 3, sha: live, kind: 'go-live' }, tag: null })
  assert.equal(unreleased.ok, false)
  assert.match(unreleased.reasons.at(-1), /go-live release of main's head, which a data refresh takes only when it is a released commit/)
  // A content rebuild still never takes a go-live release.
  const content = await findTarget({ token: 't', repo, environment: 'live', ...facts({ deployment: { id: 3, sha: live, kind: 'go-live' } }) })
  assert.match(content.reasons[0], /content rebuilds start once a version release is live/)
  assert.match((await find({ deployment: { id: 1, sha: live, kind: 'manual' } })).reasons[0], /before refreshing it/)
  // Nor over a release published with its feed data (its usual kind, with a refresh payload).
  const withData = await findTarget({ token: 't', repo, environment: 'live', ...facts({ deployment: { id: 4, sha: live, kind: 'version', refreshed: true } }) })
  assert.match(withData.reasons[0], /was published with its feed data/)
  assert.equal((await find({ deployment: { id: 4, sha: live, kind: 'version', refreshed: true } })).ok, true)
  // A content rebuild never rebuilds over a refresh: it would publish the site without its feed data.
  const over = await findTarget({ token: 't', repo, environment: 'live', ...facts({ deployment: { id: 2, sha: live, kind: 'refresh' } }) })
  assert.match(over.reasons[0], /kind refresh, not one release records; look before rebuilding it/)
  assert.match((await find({ deployment: null })).reasons[0], /nothing to refresh/)
})

test('target(): the data-refresh dispatch, checked, then the refresh target', async () => {
  const base = { token: 't', repo, event: 'repository_dispatch', dispatch: 'data-refresh', environment: 'live-lapeerrealty-com', ...dispatch }
  const asked = []
  const find = async (a) => (asked.push(a.refresh), { ok: true, sha: live, basis: 'version', tag: 'v1.4.0' })
  assert.deepEqual(await target({ ...base, find }), { ok: true, sha: live, basis: 'version', tag: 'v1.4.0', refresh: true, reason: 'due' })
  assert.deepEqual(asked, [true])
  const never = async () => assert.fail('no lookup')
  assert.equal((await target({ ...base, sender: 'someone', find: never })).ok, false)
  assert.equal(describeRefresh({ sha: live, basis: 'version', tag: 'v1.4.0', reason: 'due' }), 'data refresh of v1.4.0 (1111111), due')
})

test('verify: a data refresh publishes the live commit as kind refresh, only with its refresh build and store done', async () => {
  const t = { ok: true, sha: live, basis: 'version', tag: 'v1.4.0', pr: 12, approver: 'GilbertJames', prs: [] }
  const checks = { findTarget: async ({ refresh }) => (assert.equal(refresh, true), t) }
  const args = { token: 't', repo, sha: head, event: 'repository_dispatch', dispatch: 'data-refresh', environment: 'live-lapeerrealty-com', checks, ...dispatch }
  const ok = await verify({ ...args, refresh: true, refreshResults: REFRESH_RESULTS_OK })
  assert.equal(ok.publish, true)
  assert.equal(ok.kind, 'refresh')
  assert.equal(ok.commit, live)
  assert.equal(ok.refresh, true)
  assert.deepEqual(ok.rebuild, { basis: 'version', tag: 'v1.4.0', reason: 'due' })
  for (const results of ['build=failure,store=skipped', 'build=success,store=failure', '', undefined, 'build=success,store=success,x']) {
    const r = await verify({ ...args, refresh: true, refreshResults: results })
    assert.equal(r.publish, false, String(results))
    assert.match(r.reasons.join(' '), /build and store didn't both succeed/)
  }
  const unasked = await verify({ ...args, refreshResults: REFRESH_RESULTS_OK })
  assert.match(unasked.reasons.join(' '), /must call release with refresh: true/)
  const bad = await verify({ ...args, sender: 'someone', refresh: true, refreshResults: REFRESH_RESULTS_OK })
  assert.equal(bad.publish, false)
})

test("verify: a refresh site's release builds with the secrets only for an approved released commit", async () => {
  const release = { ok: true, reasons: [], sha: head, pr: 13, approver: 'GilbertJames' }
  const checks = { checkRelease: async () => release, checkDependencyRun: async () => ({ ok: true, nothing: false, reasons: [], prs: [7] }) }
  // check-only: verify alone says whether the run's commit may be built with the secrets.
  const version = await verify({ token: 't', repo, ref: 'refs/tags/v1.5.0', sha: head, checks, checkOnly: true })
  assert.deepEqual([version.publish, version.kind, version.refreshable], [true, 'version', true])
  const weekly = await verify({ token: 't', repo, ref: 'refs/heads/main', sha: head, checks, checkOnly: true })
  assert.deepEqual([weekly.kind, weekly.refreshable], ['dependency', true])
  // Then the release publishes the run's refresh of its own commit.
  const withData = await verify({ token: 't', repo, ref: 'refs/tags/v1.5.0', sha: head, checks, refresh: true, refreshResults: REFRESH_RESULTS_OK })
  assert.deepEqual([withData.publish, withData.kind, withData.refresh], [true, 'version', true])
  assert.equal((await verify({ token: 't', repo, ref: 'refs/tags/v1.5.0', sha: head, checks, refresh: true, refreshResults: 'build=failure,store=skipped' })).publish, false)

  // A go-live release (main's head): refreshable only when that commit is itself an approved release.
  const goLive = { token: 't', repo, ref: 'refs/heads/main', sha: head, event: 'repository_dispatch', dispatch: 'go-live-release', sender: 'coderizehq-platform[bot]', site, payloadSite: site }
  const approved = { ...checks, approvedCommit: async ({ sha }) => (assert.equal(sha, head), { ok: true, sha, basis: 'version', tag: 'v1.5.0' }) }
  assert.equal((await verify({ ...goLive, checks: approved, checkOnly: true })).refreshable, true)
  const unapproved = { ...checks, approvedCommit: async () => ({ ok: false, reasons: ["main's head 2222222 is neither"] }) }
  const plain = await verify({ ...goLive, checks: unapproved, checkOnly: true })
  assert.deepEqual([plain.publish, plain.refreshable], [true, false])
  const refused = await verify({ ...goLive, checks: unapproved, refresh: true, refreshResults: REFRESH_RESULTS_OK })
  assert.equal(refused.publish, false)
  assert.match(refused.reasons[0], /go-live release of 2222222 isn't an approved released commit, so it can't be built with the site's feed secrets/)
  // Any other site's go-live reads nothing more than before.
  const never = { ...checks, approvedCommit: async () => assert.fail('no approval lookup for a site without refresh') }
  assert.deepEqual(await verify({ ...goLive, checks: never }), { publish: true, kind: 'go-live', pr: null, approver: null, reasons: [] })
})

test('a refresh is stored write-once in its run\'s own folder, beside the commit\'s first build, and read only as that refresh', async () => {
  assert.equal(refreshPrefix(site, live, run), `_builds/${site}/${live}/refreshes/5151/`)
  assert.equal(manifestKey(site, live, refreshRef(run)), `_builds/${site}/${live}/refreshes/5151/manifest.json`)
  assert.equal(storedKey(site, live, 'index.html', refreshRef(run)), `_builds/${site}/${live}/refreshes/5151/files/index.html`)
  assert.equal(storedPrefix(site, live, refreshRef(run)), `_builds/${site}/${live}/refreshes/5151/`)
  assert.throws(() => refreshRef('../x'))

  const base = { site, repo, commit: live, workflowSha: '3'.repeat(40), lockfileSha256: '4'.repeat(64), created: 'x', files: [{ path: 'index.html', size: 4, sha256: 'd'.repeat(64) }] }
  const m = makeManifest({ ...base, refresh: { run } })
  assert.deepEqual(m.refresh, { run })
  const who = { site, repo, commit: live }
  assert.equal(readManifest(m, { ...who, rebuild: refreshRef(run) }).length, 1)
  assert.throws(() => readManifest(m, who), /is a data refresh, not the commit's own build/)
  assert.throws(() => readManifest(m, { ...who, rebuild: run }), /is a data refresh/)
  assert.throws(() => readManifest(m, { ...who, rebuild: refreshRef('5152') }), /isn't data refresh 5152's/)
  assert.throws(() => readManifest(makeManifest(base), { ...who, rebuild: refreshRef(run) }), /isn't data refresh 5151's/)

  const dir = await mkdtemp(path.join(tmpdir(), 'refresh-'))
  for (const [name, body] of Object.entries({ 'index.html': '<h1>listings</h1>', 'listings/a/index.html': '<h1>a</h1>' })) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await writeFile(path.join(dir, name), body)
  }
  const store = memoryStore()
  const common = { store, site, repo, commit: live, workflowSha: '3'.repeat(40), lockfileSha256: '4'.repeat(64), buildDir: dir, log: () => {} }
  const stored = await storeBuild({ ...common, refresh: { run } })
  assert.equal(stored.reused, false)
  const manifest = JSON.parse((await store.get(PREVIEW_BUCKET, manifestKey(site, live, refreshRef(run)))).body)
  assert.deepEqual(manifest.refresh, { run })
  assert.equal(await store.get(PREVIEW_BUCKET, manifestKey(site, live)), null, "the commit's own build is untouched")
  assert.equal((await storeBuild({ ...common, refresh: { run } })).reused, true)
  await assert.rejects(storeBuild({ ...common, refresh: { run }, rebuild: { run, contentSha256: null } }), /not both/)
  await rm(dir, { recursive: true })
})

test("publish: a refresh copies this run's stored refresh, also before an alias move, and only while live runs its commit", async () => {
  const store = memoryStore()
  const files = { 'index.html': '<h1>500 listings</h1>', 'robots.txt': 'User-agent: *\nAllow: /\n' }
  const manifest = { version: 1, site, repo, commit: live, workflow_sha: '3'.repeat(40), lockfile_sha256: '4'.repeat(64), created: 'x', refresh: { run }, files: {} }
  for (const [name, body] of Object.entries(files)) {
    store.seed(PREVIEW_BUCKET, storedKey(site, live, name, refreshRef(run)), body)
    manifest.files[name] = { size: Buffer.byteLength(body), sha256: hashes(Buffer.from(body)).sha256 }
  }
  store.seed(PREVIEW_BUCKET, manifestKey(site, live, refreshRef(run)), JSON.stringify(manifest))
  await publishLive({ store, site, repo, commit: live, rebuild: refreshRef(run), distributionId: 'EMOVE', log: () => {} })
  assert.equal((await store.get(`coderizehq-live-${site}`, 'index.html')).body.toString(), '<h1>500 listings</h1>')
  for (const c of store.calls.filter((x) => x[0] === 'copy')) assert.match(c[1], new RegExp(`/_builds/${site}/${live}/refreshes/${run}/files/`))

  assert.equal(refreshRefusal('refresh', { commit: live, liveSha: live }), null)
  assert.match(refreshRefusal('refresh', { commit: live, liveSha: head }), /live moved from 1111111 to 2222222 since this data refresh found its target/)
  assert.equal(refreshRefusal('version', { commit: live, liveSha: head }), null)
})

test("a refresh's deployment names its run, basis and reason; a release with its feed data says so", () => {
  const refresh = { run, basis: 'version', tag: 'v1.4.0', reason: 'due' }
  const p = deploymentPayload({ kind: 'refresh', commit: live, workflowSha: '3'.repeat(40), domain: 'lapeerrealty.com', runUrl: 'https://run', refresh })
  assert.deepEqual(p.refresh, { run, basis: 'version', tag: 'v1.4.0', reason: 'due' })
  assert.equal('refresh' in deploymentPayload({ kind: 'version', commit: live, workflowSha: '3'.repeat(40), domain: 'x', runUrl: 'x' }), false)
  assert.ok(KINDS.includes('refresh'))
  assert.equal(describe({ kind: 'refresh', commit: live, refresh }), 'data refresh of v1.4.0 (1111111), due')
  assert.equal(describe({ kind: 'version', pr: 13, approver: 'GilbertJames', refresh: { run } }), 'release PR #13, approved by GilbertJames, built with its feed data (refresh 5151)')
})

test('refresh-build.yml: Contents: read only, the environment it is given, secrets only in the steps after install, only the named ones', async () => {
  const wf = await workflow('refresh-build.yml')
  assert.match(wf, /workflow_call:/)
  const code = wf
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
  assert.doesNotMatch(code, /id-token|configure-aws-credentials|: write/)
  assert.match(wf, /environment: \$\{\{ inputs\.environment \}\}\n\s+permissions:\n\s+contents: read\n/)
  assert.match(wf, /value: \$\{\{ jobs\.build\.outputs\.lockfile-sha256 \}\}/)
  // The checks come first; the environment must be refresh or refresh-<site>, matching the package.
  const order = ['- name: Check the refresh', 'actions/checkout@', '- name: Hash the lockfile', '- name: Install, with no secrets', '- name: Take the named secrets', '- name: Build with the feed', 'actions/upload-artifact@']
  const at = order.map((s) => wf.indexOf(s))
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'steps in order')
  assert.ok(at.every((i) => i > 0))
  assert.match(wf, /if \[ -z "\$PACKAGE" \]; then want=refresh; else want="refresh-\$SITE"; fi/)
  // A release builds its own commit; only a data-refresh dispatch builds the live one rebuild-target found.
  assert.match(wf, /\[ "\$COMMIT" = "\$GITHUB_SHA" \] \|\| fail/)
  // Whatever install scripts write to the environment files is discarded, and the build refused.
  const install = wf.slice(wf.indexOf('- name: Install, with no secrets'), wf.indexOf('- name: Take the named secrets'))
  assert.match(install, /pnpm install --frozen-lockfile\n\s+for f in "\$GITHUB_ENV" "\$GITHUB_PATH"; do\n\s+if \[ -s "\$f" \]; then\n\s+: > "\$f"/)
  assert.match(wf, /\(GITHUB_\|ACTIONS_\|RUNNER_\|AWS_\|NODE_\|NPM_\|PNPM_\|COREPACK_\|PUBLIC_\|VITE_\|NEXT_PUBLIC_\|BASH_FUNC_\)/)
  assert.match(wf, /CI \| PATH \| HOME \| SHELL \| ENV \| BASH_ENV \| LD_PRELOAD \| LD_LIBRARY_PATH \| TMPDIR \| IFS \| PS4 \| PROMPT_COMMAND \| SHELLOPTS \| BASHOPTS\)/)
  assert.match(wf, /ref: \$\{\{ inputs\.commit \}\}\n\s+persist-credentials: false/)
  // secrets appear once, as the take step's environment; never in a run line, and never in install or build.
  assert.equal((wf.match(/\$\{\{ toJSON\(secrets\) \}\}/g) ?? []).length, 1)
  assert.doesNotMatch(wf, /secrets\.[A-Z]/)
  const take = wf.slice(wf.indexOf('- name: Take the named secrets'), wf.indexOf('- name: Build with the feed'))
  assert.match(take, /ALL: \$\{\{ toJSON\(secrets\) \}\}/)
  // Into a file only the build step reads and deletes, never $GITHUB_ENV (which every later step, the upload too, gets).
  assert.doesNotMatch(code, />>\s*"\$GITHUB_ENV"/)
  assert.doesNotMatch(take, /GITHUB_ENV/)
  assert.match(take, /umask 077\n\s+file="\$RUNNER_TEMP\/refresh-secrets"/)
  const buildStep = wf.slice(wf.indexOf('- name: Build with the feed'), wf.indexOf('actions/upload-artifact@'))
  assert.match(buildStep, /while IFS= read -r -d '' pair; do export "\$pair"; done < "\$file"\n\s+rm -f "\$file"/)
  assert.ok(buildStep.indexOf('rm -f "$file"') < buildStep.indexOf('pnpm run build'))
  // build-dir is a plain folder, so the upload never takes the runner's own files.
  assert.match(wf, /BUILD_DIR: \$\{\{ inputs\.build-dir \}\}[\s\S]*build-dir is a folder inside the package/)
  for (const l of wf.split('\n')) if (/^\s*run: /.test(l)) assert.doesNotMatch(l, /\$\{\{/, l)
  assert.match(wf, /name: site-build\n/)
})

test('deploy-preview.yml: a refresh store skips the build, takes the caller\'s artifact on main or a version tag, and emails on a tag too', async () => {
  const wf = await workflow('deploy-preview.yml')
  assert.match(wf, /refresh-lockfile-sha256:\n\s+description: .+\n\s+type: string\n\s+default: ''/)
  const build = wf.slice(wf.indexOf('\n  build:'), wf.indexOf('\n  deploy:'))
  assert.match(build, /if: inputs\.refresh-lockfile-sha256 == ''/)
  const deploy = wf.slice(wf.indexOf('\n  deploy:'), wf.indexOf('\n  notify:'))
  assert.match(deploy, /needs\.build\.result == 'skipped' && inputs\.refresh-lockfile-sha256 != ''/)
  // The build-and-publish path itself runs only on main: a tag only ever stores a refresh.
  assert.match(build, /- name: Check the ref\n\s+run: \|\n\s+\[ "\$GITHUB_REF" = refs\/heads\/main \]/)
  const check = deploy.slice(deploy.indexOf('- name: Check the refresh store'), deploy.indexOf('- name: Find this workflow'))
  assert.match(check, /if: inputs\.refresh-lockfile-sha256 != ''/)
  assert.match(check, /refs\/heads\/main \|\| "\$GITHUB_REF" =~ \^refs\/tags\/v/)
  assert.match(deploy, /REFRESH_RUN: \$\{\{ inputs\.refresh-lockfile-sha256 != '' && github\.run_id \|\| '' \}\}/)
  assert.match(deploy, /LOCKFILE_SHA256: \$\{\{ inputs\.refresh-lockfile-sha256 \|\| needs\.build\.outputs\.lockfile-sha256 \}\}/)
  assert.doesNotMatch(wf, /secrets\./)
  const notify = wf.slice(wf.indexOf('\n  notify:'))
  assert.match(notify, /startsWith\(github\.ref, 'refs\/tags\/v'\)/)
})

test('release.yml: check-only, refresh and refresh-results, its outputs, and the refresh run for publish', async () => {
  const wf = await workflow('release.yml')
  for (const input of ['check-only', 'refresh']) assert.match(wf, new RegExp(`${input}:\\n\\s+description: .+\\n\\s+type: boolean\\n\\s+default: false`))
  assert.match(wf, /refresh-results:\n\s+description: .+\n\s+type: string\n\s+default: ''/)
  for (const out of ['publish', 'commit', 'refreshable']) assert.match(wf, new RegExp(`${out}:\\n\\s+description: .+\\n\\s+value: \\$\\{\\{ jobs\\.verify\\.outputs\\.${out} \\}\\}`))
  const verifyJob = wf.slice(wf.indexOf('\n  verify:'), wf.indexOf('\n  publish:'))
  for (const line of ['PAYLOAD_REASON: ${{ github.event.client_payload.reason }}', 'CHECK_ONLY: ${{ inputs.check-only }}', 'REFRESH: ${{ inputs.refresh }}', 'REFRESH_RESULTS: ${{ inputs.refresh-results }}']) {
    assert.ok(verifyJob.includes(line), line)
  }
  const publish = wf.slice(wf.indexOf('\n  publish:'), wf.indexOf('\n  notify:'))
  assert.match(publish, /if: needs\.verify\.outputs\.publish == 'true' && !inputs\.check-only/)
  // A check-only call that passes emails nobody: notify sends on a published release or a failure, and check-only
  // never publishes.
  const notify = wf.slice(wf.indexOf('\n  notify:'))
  assert.match(notify, /\(needs\.publish\.result == 'success' \|\| contains\(needs\.\*\.result, 'failure'\)\)/)
  assert.match(publish, /REFRESH_RUN: \$\{\{ needs\.verify\.outputs\.refresh == 'true' && github\.run_id \|\| '' \}\}/)
  assert.doesNotMatch(wf, /secrets\.(?!RELEASE)/)
  const rt = await workflow('rebuild-target.yml')
  assert.ok(rt.includes('PAYLOAD_REASON: ${{ github.event.client_payload.reason }}'))
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { deployApp, imageBuildState, SERVER_NAME } from './deployApp.mjs'

const commit = 'd'.repeat(40)

// A fake of the AWS calls: the image tags ECR has (from the `imageAfter`th look, for an image still building), the
// running servers, and the statuses the command passes through.
function fakeAws({
  tags = [`coderizehq-app-example-api:${commit}`],
  imageAfter = 0,
  servers = ['i-0abc'],
  statuses = ['InProgress', 'Success'],
  stdout = 'running',
  stderr = '',
} = {}) {
  const sent = []
  const tagged = []
  let polls = 0
  let looks = 0
  return {
    sent,
    tagged,
    get looks() {
      return looks
    },
    addTag: async (repo, from, tag) => {
      tagged.push([repo, from, tag])
      return true
    },
    hasTag: async (repo, tag) => looks++ >= imageAfter && tags.includes(`${repo}:${tag}`),
    instances: async (name) => (name === SERVER_NAME ? servers : []),
    send: async (cmd) => {
      sent.push(cmd)
      return 'cmd-1'
    },
    invocation: async () => {
      const status = statuses[Math.min(polls++, statuses.length - 1)]
      return status === null ? null : { status, stdout, stderr }
    },
  }
}

const run = (aws, extra = {}) => deployApp({ aws, app: 'example-api', commit, wait: async () => {}, log: () => {}, ...extra })

test('runs only the app own document on the one app server, with the commit as the tag, then tags the release', async () => {
  const aws = fakeAws()
  assert.deepEqual(await run(aws), { commandId: 'cmd-1', instanceId: 'i-0abc' })
  assert.deepEqual(aws.tagged, [['coderizehq-app-example-api', commit, `release-${commit}`]])
  assert.deepEqual(aws.sent, [
    { document: 'coderizehq-deploy-example-api', instanceId: 'i-0abc', parameters: { Tag: [commit] }, comment: `deploy example-api ${commit.slice(0, 12)}` },
  ])
})

test('waits while SSM has not registered the command yet', async () => {
  await run(fakeAws({ statuses: [null, null, 'Pending', 'InProgress', 'Success'] }))
})

test('waits for an image build-app-image is still pushing, one line per check, then deploys', async () => {
  const lines = []
  const waits = []
  const aws = fakeAws({ imageAfter: 2 })
  await run(aws, { log: (l) => lines.push(l), wait: async (ms) => waits.push(ms), pollMs: 10_000 })
  assert.equal(lines.filter((l) => l === `waiting for the image of ${commit} (build-app-image on main)`).length, 2)
  assert.deepEqual(waits.slice(0, 2), [20_000, 20_000])
  assert.equal(aws.sent.length, 1)
})

test('refuses a commit whose image never comes, with the same message, after 15 minutes and before sending anything', async () => {
  const waits = []
  const aws = fakeAws({ tags: [] })
  await assert.rejects(
    run(aws, { wait: async (ms) => waits.push(ms) }),
    new RegExp(`^Error: no image for ${commit} in coderizehq-app-example-api: has build-app-image finished on main for this commit\\?$`),
  )
  assert.equal(waits.reduce((a, b) => a + b, 0), 15 * 60_000)
  assert.equal(aws.looks, 46)
  assert.equal(aws.sent.length, 0)
})

test('keeps waiting while build-app-image runs, and stops early once it ended without pushing the image', async () => {
  const states = [{ state: 'running' }, { state: 'running' }, { state: 'done', conclusion: 'failure' }]
  let asked = 0
  const aws = fakeAws({ tags: [] })
  await assert.rejects(run(aws, { imageBuild: async () => states[asked++] }), /ended failure without pushing it/)
  assert.equal(asked, 3)
  assert.equal(aws.sent.length, 0)
})

test('deploys when build-app-image finished between the ECR check and the runs check', async () => {
  const aws = fakeAws({ imageAfter: 1 })
  await run(aws, { imageBuild: async () => ({ state: 'done', conclusion: 'success' }) })
  assert.equal(aws.sent.length, 1)
})

test('gives GitHub time to start the build before taking "nothing ran on main" as final', async () => {
  const aws = fakeAws({ tags: [] })
  await assert.rejects(run(aws, { imageBuild: async () => ({ state: 'none' }), noRunChecks: 3 }), /nothing ran on main for this commit/)
  assert.equal(aws.looks, 4)
})

test('a runs lookup that fails, or tells nothing, leaves ECR to decide', async () => {
  const lines = []
  const failing = fakeAws({ imageAfter: 3 })
  await run(failing, {
    log: (l) => lines.push(l),
    imageBuild: async () => {
      throw new Error('GET /repos/o/r/actions/runs: 500')
    },
  })
  assert.equal(lines.filter((l) => l.startsWith("couldn't read build-app-image's runs")).length, 1)
  assert.equal(failing.sent.length, 1)

  const unknown = fakeAws({ tags: [] })
  await assert.rejects(run(unknown, { imageBuild: async () => null, maxImageChecks: 4 }), /has build-app-image finished/)
  assert.equal(unknown.looks, 5)
})

test('reads build-app-image state from the commit runs on main', () => {
  const build = (status, conclusion = null, extra = {}) => ({
    event: 'push',
    head_branch: 'main',
    status,
    conclusion,
    referenced_workflows: [{ path: 'CoderizeHQ/actions/.github/workflows/build-app-image.yml@v1' }],
    ...extra,
  })
  const tagDeploy = build('in_progress', null, { head_branch: 'v1.0.1', referenced_workflows: [{ path: 'CoderizeHQ/actions/.github/workflows/deploy-app.yml@v1' }] })

  assert.deepEqual(imageBuildState([]), { state: 'none' })
  assert.deepEqual(imageBuildState([tagDeploy]), { state: 'none' })
  assert.deepEqual(imageBuildState([tagDeploy, build('queued')]), { state: 'running' })
  assert.deepEqual(imageBuildState([build('completed', 'failure'), build('in_progress')]), { state: 'running' })
  assert.deepEqual(imageBuildState([build('completed', 'failure')]), { state: 'done', conclusion: 'failure' })
  assert.deepEqual(imageBuildState([build('completed', 'cancelled'), build('completed', 'failure')]), { state: 'done', conclusion: 'cancelled, failure' })
  // Something ran on main, but none of it is build-app-image as far as the runs show: can't tell.
  assert.equal(imageBuildState([build('in_progress', null, { referenced_workflows: [] })]), null)
})

test('refuses when there is not exactly one running app server', async () => {
  await assert.rejects(run(fakeAws({ servers: [] })), /expected one running coderizehq-app-server, found 0/)
  await assert.rejects(run(fakeAws({ servers: ['i-1', 'i-2'] })), /found 2/)
})

test('fails loudly when the document fails, prints what the server printed, and tags nothing', async () => {
  const lines = []
  const aws = fakeAws({ statuses: ['Failed'], stderr: 'health never answered' })
  await assert.rejects(run(aws, { log: (l) => lines.push(l) }), /the deploy ended Failed/)
  assert.ok(lines.includes('health never answered'))
  assert.deepEqual(aws.tagged, [])
})

test('fails when the command never finishes in time', async () => {
  await assert.rejects(run(fakeAws({ statuses: ['InProgress'] }), { maxPolls: 3 }), /didn't finish in time/)
})

test('checks the app name and the commit before calling AWS', async () => {
  const aws = fakeAws()
  await assert.rejects(deployApp({ aws, app: 'Bad', commit, wait: async () => {}, log: () => {} }), /app must/)
  await assert.rejects(deployApp({ aws, app: 'example-api', commit: 'v1.0.0', wait: async () => {}, log: () => {} }), /commit must/)
  assert.equal(aws.sent.length, 0)
})

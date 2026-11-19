import assert from 'node:assert/strict'
import { test } from 'node:test'

import { deployApp, SERVER_NAME } from './deployApp.mjs'

const commit = 'd'.repeat(40)

// A fake of the AWS calls: the image tags ECR has, the running servers, and the statuses the command passes through.
function fakeAws({ tags = [`coderizehq-app-example-api:${commit}`], servers = ['i-0abc'], statuses = ['InProgress', 'Success'], stdout = 'running', stderr = '' } = {}) {
  const sent = []
  const tagged = []
  let polls = 0
  return {
    sent,
    tagged,
    addTag: async (repo, from, tag) => {
      tagged.push([repo, from, tag])
      return true
    },
    hasTag: async (repo, tag) => tags.includes(`${repo}:${tag}`),
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

test('refuses a commit with no image, before sending anything', async () => {
  const aws = fakeAws({ tags: [] })
  await assert.rejects(run(aws), /no image for/)
  assert.equal(aws.sent.length, 0)
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

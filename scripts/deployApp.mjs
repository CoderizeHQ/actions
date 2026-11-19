// deploy-app's deploy step (platform docs/apps.md, "Releases"). Runs as the app's coderizehq-app-deploy-<app> role,
// which may only run the app's own deploy document on the app server:
// 1. checks build-app-image pushed this commit's image;
// 2. finds the app server (the one running instance named coderizehq-app-server);
// 3. runs coderizehq-deploy-<app> there with the commit as the tag, and waits for it;
// 4. prints what the server printed, and fails unless the document ended in Success (the document leaves the live
//    release as it was when the new one fails);
// 5. tags the image release-<sha> in ECR, so the lifecycle keeps the last 3 releases apart from newer builds.

import { checkApp, checkCommit, repositoryName } from './appImage.mjs'
import { runIfMain, summary } from './lib/report.mjs'

export const SERVER_NAME = 'coderizehq-app-server'
const DONE = new Set(['Success', 'Failed', 'Cancelled', 'TimedOut', 'Cancelling'])

export async function deployApp({ aws, app, commit, wait = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 10_000, maxPolls = 186, log = console.log }) {
  checkApp(app)
  checkCommit(commit)

  if (!(await aws.hasTag(repositoryName(app), commit))) {
    throw new Error(`no image for ${commit} in ${repositoryName(app)}: has build-app-image finished on main for this commit?`)
  }

  const servers = await aws.instances(SERVER_NAME)
  if (servers.length !== 1) throw new Error(`expected one running ${SERVER_NAME}, found ${servers.length}`)
  const [instanceId] = servers

  const commandId = await aws.send({
    document: `coderizehq-deploy-${app}`,
    instanceId,
    parameters: { Tag: [commit] },
    comment: `deploy ${app} ${commit.slice(0, 12)}`,
  })
  log(`sent ${commandId} to ${instanceId}; waiting (the server may queue it behind another app's deploy)`)

  // 186 polls of 10 s: the document's own 30-minute timeout, plus a little.
  let result = null
  for (let i = 0; i < maxPolls; i++) {
    await wait(pollMs)
    result = await aws.invocation(commandId, instanceId)
    if (result && DONE.has(result.status)) break
  }

  if (result?.stdout) log(result.stdout.trimEnd())
  if (result?.stderr) log(result.stderr.trimEnd())
  if (!result || !DONE.has(result.status)) throw new Error(`${commandId} didn't finish in time; check it in Systems Manager before deploying again`)
  if (result.status !== 'Success') throw new Error(`the deploy ended ${result.status}; the live release, if there was one, is as it was`)

  const tagged = await aws.addTag(repositoryName(app), commit, `release-${commit}`)
  log(tagged ? `tagged release-${commit}` : `release-${commit} was already tagged`)
  return { commandId, instanceId }
}

runIfMain(import.meta.url, async () => {
  const { awsDeploy } = await import('./lib/aws.mjs')
  const app = process.env.APP
  const commit = process.env.COMMIT
  const { commandId } = await deployApp({ aws: awsDeploy(), app, commit })
  summary(`Deployed \`${app}\` at \`${commit}\` (${commandId})`)
})

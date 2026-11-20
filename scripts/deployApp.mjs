// deploy-app's deploy step (platform docs/apps.md, "Releases"). Runs as the app's coderizehq-app-deploy-<app> role,
// which may only run the app's own deploy document on the app server:
// 1. checks build-app-image pushed this commit's image, waiting up to 15 minutes for a build still running;
// 2. finds the app server (the one running instance named coderizehq-app-server);
// 3. runs coderizehq-deploy-<app> there with the commit as the tag, and waits for it;
// 4. prints what the server printed, and fails unless the document ended in Success (the document leaves the live
//    release as it was when the new one fails);
// 5. tags the image release-<sha> in ECR, so the lifecycle keeps the last 3 releases apart from newer builds.

import { checkApp, checkCommit, repositoryName } from './appImage.mjs'
import { gh } from './lib/github.mjs'
import { runIfMain, summary } from './lib/report.mjs'

export const SERVER_NAME = 'coderizehq-app-server'
const DONE = new Set(['Success', 'Failed', 'Cancelled', 'TimedOut'])
const BUILD_WORKFLOW = 'coderizehq/actions/.github/workflows/build-app-image.yml@'

/**
 * Where build-app-image stands for a commit, from the app repo's workflow runs for it:
 * `none` when nothing ran on a push to main for the commit (so no image is coming), `running` while a build-app-image
 * run is unfinished, `done` (with its conclusion) once every one has ended, and null when the runs can't tell.
 * @param {any[]} runs GitHub's workflow runs for the commit
 * @returns {{ state: 'none' | 'running' } | { state: 'done', conclusion: string } | null}
 */
export function imageBuildState(runs) {
  const onMain = runs.filter((r) => r.event === 'push' && r.head_branch === 'main')
  if (!onMain.length) return { state: 'none' }
  const builds = onMain.filter((r) => (r.referenced_workflows ?? []).some((w) => w.path?.toLowerCase().startsWith(BUILD_WORKFLOW)))
  if (!builds.length) return null
  if (builds.some((r) => r.status !== 'completed')) return { state: 'running' }
  return { state: 'done', conclusion: [...new Set(builds.map((r) => r.conclusion))].join(', ') }
}

// The release PR's merge pushes main (build-app-image) and the version tag (this deploy) at the same moment, so the
// image is often still building when the deploy starts. Waits for it: 45 checks 20 s apart, 15 minutes. With
// `imageBuild` (the app repo's runs, from GitHub), it stops early when build-app-image ended without pushing the
// image, or when nothing ran on main for the commit after `noRunChecks` checks (time for GitHub to start the run).
// A lookup that fails only leaves ECR to decide.
async function waitForImage({ aws, repository, commit, imageBuild, wait, pollMs, maxChecks, noRunChecks, log }) {
  const noImage = (why) => new Error(`no image for ${commit} in ${repository}: ${why}`)
  for (let check = 0; ; check++) {
    if (await aws.hasTag(repository, commit)) return
    let build = null
    if (imageBuild) {
      try {
        build = await imageBuild(commit)
      } catch (err) {
        log(`couldn't read build-app-image's runs (${err.message}); waiting on ECR alone`)
        imageBuild = null
      }
    }
    if (build?.state === 'done') {
      // A build that finished between the two reads has pushed by now.
      if (await aws.hasTag(repository, commit)) return
      throw noImage(`build-app-image on main for this commit ended ${build.conclusion} without pushing it`)
    }
    if (build?.state === 'none' && check >= noRunChecks) throw noImage('nothing ran on main for this commit, so build-app-image never built it')
    if (check >= maxChecks) throw noImage('has build-app-image finished on main for this commit?')
    log(`waiting for the image of ${commit} (build-app-image on main)`)
    await wait(pollMs)
  }
}

export async function deployApp({
  aws,
  app,
  commit,
  imageBuild,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  imagePollMs = 20_000,
  maxImageChecks = 45,
  noRunChecks = 6,
  pollMs = 10_000,
  maxPolls = 186,
  log = console.log,
}) {
  checkApp(app)
  checkCommit(commit)

  await waitForImage({ aws, repository: repositoryName(app), commit, imageBuild, wait, pollMs: imagePollMs, maxChecks: maxImageChecks, noRunChecks, log })

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
  const { APP: app, COMMIT: commit, GH_TOKEN: token, REPO: repo } = process.env
  // The app repo's runs for the commit, with the job's own token (actions: read). Optional: without it, the deploy
  // waits on ECR alone.
  const imageBuild =
    token && repo
      ? async (sha) => {
          const res = await gh(token, `/repos/${repo}/actions/runs?head_sha=${sha}&event=push&branch=main&per_page=100`)
          if (!res) throw new Error(`${repo}'s workflow runs aren't readable`)
          return imageBuildState(res.workflow_runs ?? [])
        }
      : undefined
  const { commandId } = await deployApp({ aws: awsDeploy(), app, commit, imageBuild })
  summary(`Deployed \`${app}\` at \`${commit}\` (${commandId})`)
})

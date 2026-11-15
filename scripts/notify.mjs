// The email a deploy-preview or release run sends to ops@coderize.dev (plan, Phase 3 "Shared workflows"; James chose
// email only, C955 a). deploy-preview sends when its build or deploy fails; release when it publishes, and when it
// fails or refuses. Plain text, from notify@notify.coderize.dev, through SES in the live account with the
// coderizehq-notify configuration set, as coderizehq-notify-send: platform's role that may send only from that address
// to ops@ (platform, aws/live/notify.tf). Its ARN is fixed here and in the workflows, never an input.
//
// `node notify.mjs` reads the run from the environment (see main below).

import { LIVE_ACCOUNT } from './lib/build.mjs'
import { runIfMain } from './lib/report.mjs'

export const FROM = 'CoderizeHQ <notify@notify.coderize.dev>'
export const TO = 'ops@coderize.dev'
export const CONFIGURATION_SET = 'coderizehq-notify'
export const NOTIFY_ROLE_ARN = `arn:aws:iam::${LIVE_ACCOUNT}:role/coderizehq-notify-send`

const WORKFLOWS = new Set(['deploy-preview', 'release'])
const BAD = new Set(['failure', 'cancelled'])

/** A value from the run, safe for a subject or one line: whitespace and control characters become one space; bounded. */
export function clean(value, max = 300) {
  return String(value ?? '')
    .replace(/[\s\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * The needs' results as the workflow passes them: `build=success,deploy=failure`.
 * @returns {{ job: string, result: string }[]}
 */
export function parseResults(text) {
  const jobs = []
  for (const pair of String(text ?? '').split(',')) {
    const m = /^([a-z-]+)=([a-z_]*)$/.exec(pair.trim())
    if (!m) throw new Error(`not a job=result pair: ${JSON.stringify(pair)}`)
    jobs.push({ job: m[1], result: m[2] || 'unknown' })
  }
  return jobs
}

/**
 * @param {{ workflow: string, site: string, repo: string, ref: string, commit: string, runUrl: string,
 *   results: string, kind?: string, releasePr?: string, approver?: string, dependencyPrs?: string, siteUrl?: string,
 *   reasons?: string }} run
 * @returns {{ ok: boolean, subject: string, text: string }}
 */
export function message(run) {
  if (!WORKFLOWS.has(run.workflow)) throw new Error(`unknown workflow ${JSON.stringify(run.workflow)}`)
  const jobs = parseResults(run.results)
  const ok = !jobs.some((j) => BAD.has(j.result))
  const site = clean(run.site, 60)
  const ref = clean(run.ref, 120)
  const commit = clean(run.commit, 40)
  const tag = ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : null
  const what = tag ?? (run.workflow === 'release' ? 'weekly dependency run' : commit.slice(0, 7))

  const subject = ok
    ? `[CoderizeHQ] ${run.workflow === 'release' ? 'released' : 'deployed preview'} ${site} ${what}`
    : `[CoderizeHQ] ${run.workflow} failed: ${site} ${what}`

  const lines = [
    `${run.workflow} ${ok ? 'succeeded' : 'failed'} for ${site} (${clean(run.repo, 100)}).`,
    '',
    `Ref:     ${ref}`,
    `Commit:  ${commit}`,
    `Jobs:    ${jobs.map((j) => `${clean(j.job, 30)} ${clean(j.result, 20)}`).join(', ')}`,
  ]
  if (run.siteUrl) lines.push(`Live:    ${clean(run.siteUrl, 200)}`)
  if (run.kind === 'version' && run.releasePr) {
    lines.push(`Release: PR #${clean(run.releasePr, 10)}, approved by ${clean(run.approver, 60) || 'nobody'}`)
  } else if (run.kind === 'dependency') {
    const prs = clean(run.dependencyPrs, 300).split(',').filter(Boolean)
    lines.push(`Release: dependency-only, Renovate PRs ${prs.map((n) => `#${n}`).join(', ') || 'none'}`)
  }
  if (run.reasons) lines.push(`Refused: ${clean(run.reasons, 1500)}`)
  lines.push(`Run:     ${clean(run.runUrl, 300)}`, '', `Sent by CoderizeHQ/actions ${run.workflow}.yml. Nobody reads replies.`)

  return { ok, subject: subject.slice(0, 200), text: `${lines.join('\n')}\n` }
}

/** Sends `message(run)` to ops@ with `mailer` (lib/aws.mjs's awsMailer, or a fake). */
export async function notify(run, mailer) {
  const m = message(run)
  const id = await mailer.send({ from: FROM, to: TO, configurationSet: CONFIGURATION_SET, subject: m.subject, text: m.text })
  return { ...m, id }
}

runIfMain(import.meta.url, async () => {
  const env = process.env
  const run = {
    workflow: env.WORKFLOW,
    site: env.SITE,
    repo: env.REPO,
    ref: env.REF,
    commit: env.COMMIT,
    runUrl: env.RUN_URL,
    results: env.RESULTS,
    kind: env.KIND,
    releasePr: env.RELEASE_PR,
    approver: env.APPROVER,
    dependencyPrs: env.DEPENDENCY_PRS,
    siteUrl: env.SITE_URL,
    reasons: env.REASONS,
  }
  const { awsMailer } = await import('./lib/aws.mjs')
  const sent = await notify(run, awsMailer())
  console.log(`emailed ${TO}: ${sent.subject} (${sent.id})`)
})

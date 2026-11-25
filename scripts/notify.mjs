// The email a deploy-preview or release run sends to ops@coderize.dev (plan, Phase 3 "Shared workflows"; James chose
// email only, C955 a). deploy-preview sends when its build or deploy fails; release when it publishes, and when it
// fails or refuses. Plain text, from notify@notify.coderize.dev, through SES in the live account with the
// coderizehq-notify configuration set, as coderizehq-notify-send: platform's role that may send only from that address
// to ops@ (platform, aws/live/notify.tf). Its ARN is fixed here and in the workflows, never an input.
//
// Two exceptions, both decided by `node notify.mjs decide` before any AWS (release.yml's notify job; shouldEmail below):
// a weekly dependency run held for James emails nothing, since platform's weekly digest lists every held site once a
// week, and a run of GitHub's backup cron that repeats one this week's slot already had emails nothing either.
//
// `node notify.mjs` reads the run from the environment (see main below).

import { LIVE_ACCOUNT } from './lib/build.mjs'
import { output, runIfMain, summary } from './lib/report.mjs'

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
  const what = tag ?? (run.kind === 'go-live' ? '(go-live)' : run.kind === 'content' ? `content rebuild of ${commit.slice(0, 7)}` : run.kind === 'refresh' ? `data refresh of ${commit.slice(0, 7)}` : run.workflow === 'release' ? 'weekly dependency run' : commit.slice(0, 7))

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
  } else if (run.kind === 'go-live') {
    lines.push("Release: go-live, main's head on the new distribution before its alias move (platform's apply)")
  } else if (run.kind === 'content') {
    lines.push("Release: content rebuild, the commit live runs now built again because its content changed (platform's content check)")
  } else if (run.kind === 'refresh') {
    lines.push("Release: data refresh, the commit live runs now built again with its feed's secrets so its data is fresh (platform's refresh check)")
  }
  if (run.reasons) lines.push(`Refused: ${clean(run.reasons, 1500)}`)
  lines.push(`Run:     ${clean(run.runUrl, 300)}`, '', `Sent by CoderizeHQ/actions ${run.workflow}.yml. Nobody reads replies.`)

  return { ok, subject: subject.slice(0, 200), text: `${lines.join('\n')}\n` }
}

// --- Whether a release run emails at all (`node notify.mjs decide`, release.yml's notify job, before any AWS) ---

/** The weekly dependency run platform's release-bootstrap starts (its scripts/siteReleases.mjs), as the release App. */
export const WEEKLY_DISPATCH = { action: 'weekly-dependency-release', sender: 'coderizehq-release[bot]' }

/** Whether the run is the automatic weekly dependency run: GitHub's cron, or platform's dispatch. Not a hand start. */
export function isWeeklyRun({ event, dispatch, sender }) {
  return event === 'schedule' || (event === 'repository_dispatch' && dispatch === WEEKLY_DISPATCH.action && sender === WEEKLY_DISPATCH.sender)
}

/**
 * The start of the slot a weekly cron (`m h * * d`, as platform writes into each site's release.yml) last named at or
 * before `at`; null for any other form, which then never counts as a repeat.
 * @param {string | undefined} cron @param {Date} at
 */
export function cronSlot(cron, at) {
  const m = /^\s*(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+([0-7])\s*$/.exec(cron ?? '')
  if (!m || Number.isNaN(at.getTime())) return null
  const [minute, hour, day] = m.slice(1).map(Number)
  if (minute > 59 || hour > 23) return null
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), hour, minute))
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - (day % 7) + 7) % 7))
  if (d > at) d.setUTCDate(d.getUTCDate() - 7)
  return d
}

/** Events whose run on main is that slot's dependency run (platform's countsAsWeeklyRun counts the same ones). */
function isEarlierWeekly(r) {
  if (r.event === 'schedule' || r.event === 'workflow_dispatch') return true
  return r.event === 'repository_dispatch' && (r.triggering_actor?.login ?? r.actor?.login) === WEEKLY_DISPATCH.sender
}

/**
 * The run a cron run repeats, or null: an earlier run of the same release workflow on main in the same weekly slot,
 * finished, for the same commit, that ended as this one did. GitHub's cron stays in each site's release.yml as a
 * backup and often fires hours after platform's dispatch already ran the week's release; that dispatch's email said
 * it all. A different commit (something merged in between) or a different outcome still emails. These are only
 * candidates: decide counts one as repeated only if its own notify really emailed (`emailed`), so a cron run that fails
 * after a held dispatch (which emailed nothing) still emails its failure.
 * @param {{ run: { id: number, created_at: string, head_sha: string }, runs: any[], slot: Date, ok: boolean }} f
 * @returns {any[]} newest first
 */
export function repeatCandidates({ run, runs, slot, ok }) {
  const created = Date.parse(run.created_at)
  const want = ok ? 'success' : 'failure'
  return runs
    .filter(
      (r) =>
        r.id !== run.id &&
        (r.head_branch ?? 'main') === 'main' &&
        Date.parse(r.created_at) >= slot.getTime() &&
        Date.parse(r.created_at) < created &&
        r.head_sha === run.head_sha &&
        r.status === 'completed' &&
        r.conclusion === want &&
        isEarlierWeekly(r),
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
}

/** Whether a release run's jobs show its notify emailed ops@: the `Email ops@` step of its notify job succeeded. */
export function emailed(jobs) {
  return (jobs ?? []).some(
    (j) => (j.name === 'notify' || j.name?.endsWith(' / notify')) && (j.steps ?? []).some((s) => s.name === 'Email ops@' && s.conclusion === 'success'),
  )
}

/**
 * Whether to email (pure). A weekly run whose release is held for James (verify's `hold`) sends nothing: a hold isn't an
 * error, and platform's weekly digest lists every held site once a week. A hand-started run still emails its hold.
 * A cron run that repeats this slot's run (`repeated`) sends nothing either. Everything else emails as before.
 * @returns {{ send: boolean, why: string }}
 */
export function shouldEmail({ event, dispatch, sender, hold, repeated = null }) {
  if (hold === 'true' && isWeeklyRun({ event, dispatch, sender })) {
    return { send: false, why: "the weekly dependency run is held for James; platform's weekly digest lists it" }
  }
  if (repeated) return { send: false, why: `GitHub's cron repeated run ${repeated.id} of this week's slot, for the same commit and with the same result, which already emailed` }
  return { send: true, why: 'emailing ops@' }
}

/**
 * Reads what shouldEmail needs from GitHub: only a cron run is looked up (its run, the release workflow's runs on main
 * since its slot, and each candidate's jobs). `api` is lib/github.mjs's gh and ghAll, bound to the token.
 */
export async function decide(env, api) {
  const base = { event: env.EVENT, dispatch: env.DISPATCH, sender: env.SENDER, hold: env.HOLD }
  const first = shouldEmail(base)
  if (!first.send || env.EVENT !== 'schedule') return first
  const run = await api.get(`/repos/${env.REPO}/actions/runs/${env.RUN_ID}`)
  const slot = run ? cronSlot(env.SCHEDULE, new Date(run.created_at)) : null
  if (!slot) return first
  const runs = await api.all(
    `/repos/${env.REPO}/actions/workflows/${run.workflow_id}/runs?branch=main&created=${encodeURIComponent(`>=${slot.toISOString()}`)}`,
    (p) => p?.workflow_runs ?? [],
  )
  const ok = !parseResults(env.RESULTS).some((j) => BAD.has(j.result))
  for (const earlier of repeatCandidates({ run, runs, slot, ok })) {
    const jobs = (await api.get(`/repos/${env.REPO}/actions/runs/${earlier.id}/jobs?filter=latest&per_page=100`))?.jobs ?? []
    if (emailed(jobs)) return shouldEmail({ ...base, repeated: earlier })
  }
  return first
}

/** Sends `message(run)` to ops@ with `mailer` (lib/aws.mjs's awsMailer, or a fake). */
export async function notify(run, mailer) {
  const m = message(run)
  const id = await mailer.send({ from: FROM, to: TO, configurationSet: CONFIGURATION_SET, subject: m.subject, text: m.text })
  return { ...m, id }
}

runIfMain(import.meta.url, async () => {
  const env = process.env
  if (process.argv[2] === 'decide') {
    // A lookup that fails emails anyway: a missed email is worse than a repeated one.
    let d
    try {
      const { gh, ghAll } = await import('./lib/github.mjs')
      d = await decide(env, { get: (p) => gh(env.GH_TOKEN, p), all: (p, pick) => ghAll(env.GH_TOKEN, p, pick) })
    } catch (err) {
      console.log(`::warning::couldn't tell whether this run repeats an earlier one (${clean(err.message, 200)}); emailing`)
      d = { send: true, why: 'emailing ops@' }
    }
    output('send', String(d.send))
    console.log(d.why)
    if (!d.send) summary(`No email: ${d.why}.`)
    return
  }
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

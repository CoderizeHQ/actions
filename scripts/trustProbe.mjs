// ci-tofu's live negative trust tests (plan, Phase 2 "Who can change what"). platform's trust.test.mjs proves each
// refusal one condition at a time against the policy templates; this proves the deployed roles refuse too. From a
// platform pull request, it takes the job's own GitHub OIDC token and calls sts:AssumeRoleWithWebIdentity on every
// role that token must never reach:
// - coderizehq-preview-deploy-<site>, each site: another repository (platform, not the site's), another workflow
//   file (ci-tofu.yml, not deploy-preview.yml), and a pull-request ref, not main;
// - coderizehq-live-publish-<site>, each live site: another repository and workflow file (not release.yml), not the
//   release environment, and a pull-request ref, not a version tag or main;
// - coderizehq-infra-deploy, each account: the right repository, but another workflow file (actions' ci-tofu.yml,
//   not platform's apply.yml), not the apply environment, and not main.
// Each must answer AccessDenied; an assumed role fails the job at once. So the refusals mean something, the same
// token must assume coderizehq-infra-plan in each account through the same call (the control), and each refused
// role must exist (iam:GetRole, as the plan role): STS answers AccessDenied for a role that isn't there.

import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { LIVE_ACCOUNT, PREVIEW_ACCOUNT } from './lib/build.mjs'
import { decodeClaims, requestToken } from './lib/oidc.mjs'
import { runIfMain, summary } from './lib/report.mjs'

export const PLATFORM_REPO_ID = '1457774113'
const STS = 'https://sts.us-east-1.amazonaws.com/'
const ACTIONS = 'CoderizeHQ/actions/.github/workflows'
const version = (file) => [`${ACTIONS}/${file}@refs/tags/v1`, `${ACTIONS}/${file}@refs/tags/v1.*`]
const arn = (account, role) => `arn:aws:iam::${account}:role/${role}`

/**
 * The roles to try, each with the claims its trust policy accepts (the site contract's table).
 * @param {{ site: string, repo: string, repo_id: number, account: string }[]} sites
 */
export function targets(sites) {
  const list = []
  for (const s of sites) {
    list.push({
      role: `coderizehq-preview-deploy-${s.site}`,
      account: PREVIEW_ACCOUNT,
      trusted: { repo: s.repo, repositoryId: String(s.repo_id), workflows: version('deploy-preview.yml'), refs: ['refs/heads/main'], environment: null },
    })
    if (s.account === 'live') {
      list.push({
        role: `coderizehq-live-publish-${s.site}`,
        account: LIVE_ACCOUNT,
        trusted: { repo: s.repo, repositoryId: String(s.repo_id), workflows: version('release.yml'), refs: ['refs/tags/v*', 'refs/heads/main'], environment: 'release' },
      })
    }
  }
  for (const account of [PREVIEW_ACCOUNT, LIVE_ACCOUNT]) {
    list.push({
      role: 'coderizehq-infra-deploy',
      account,
      trusted: { repo: 'platform', repositoryId: PLATFORM_REPO_ID, workflows: ['CoderizeHQ/platform/.github/workflows/apply.yml@refs/heads/main'], refs: ['refs/heads/main'], environment: 'apply' },
    })
  }
  return list.map((t) => ({ ...t, arn: arn(t.account, t.role) }))
}

/** IAM's StringLike: * is any run of characters. */
function like(pattern, value) {
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${re}$`, 's').test(String(value ?? ''))
}

/**
 * How this token differs from what a role trusts: the refusals its attempt demonstrates.
 * @param {Record<string, string>} claims @param {ReturnType<typeof targets>[number]['trusted']} trusted
 */
export function differences(claims, trusted) {
  const out = []
  if (claims.repository_id !== trusted.repositoryId) out.push(`another repository (${claims.repository}, not ${trusted.repo})`)
  if (!trusted.workflows.some((w) => like(w, claims.job_workflow_ref))) out.push(`another workflow file (${claims.job_workflow_ref})`)
  if ((claims.environment ?? null) !== trusted.environment) {
    out.push(trusted.environment ? `not the ${trusted.environment} environment` : `an environment (${claims.environment})`)
  }
  if (!trusted.refs.some((r) => like(r, claims.ref))) out.push(`the ref ${claims.ref}, not ${trusted.refs.join(' or ')}`)
  return out
}

/** STS's answer: assumed, or the error code. */
export function parseSts(status, xml) {
  if (status === 200 && xml.includes('<AssumeRoleWithWebIdentityResult>')) return { assumed: true }
  return { assumed: false, code: /<Code>([^<]+)<\/Code>/.exec(xml)?.[1] ?? `HTTP ${status}`, message: /<Message>([^<]*)<\/Message>/.exec(xml)?.[1] ?? '' }
}

/**
 * One unsigned AssumeRoleWithWebIdentity call (the call needs no AWS credentials, only the token). The credentials
 * of a successful call are never read.
 */
export async function tryAssume(roleArn, token, fetchImpl = fetch) {
  const body = new URLSearchParams({
    Action: 'AssumeRoleWithWebIdentity',
    Version: '2011-06-15',
    RoleArn: roleArn,
    RoleSessionName: 'negative-trust-test',
    DurationSeconds: '900',
    WebIdentityToken: token,
  })
  const res = await fetchImpl(STS, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  return parseSts(res.status, await res.text())
}

/** Does the role exist? Asked as the account's plan role, through the AWS CLI profile the workflow set up. */
export async function roleExistsCli(account, role) {
  const profile = { [PREVIEW_ACCOUNT]: 'preview', [LIVE_ACCOUNT]: 'live' }[account]
  try {
    await promisify(execFile)('aws', ['iam', 'get-role', '--role-name', role, '--profile', profile, '--query', 'Role.Arn', '--output', 'text'])
    return true
  } catch (err) {
    if (/NoSuchEntity/.test(String(err.stderr))) return false
    throw new Error(`iam get-role ${role} in ${account}: ${String(err.stderr || err.message).trim()}`)
  }
}

/**
 * Runs every attempt and judges it.
 * @param {{ claims: Record<string, string>, token: string, sites: any[], assume?: typeof tryAssume, roleExists?: typeof roleExistsCli }} input
 */
export async function probe({ claims, token, sites, assume = tryAssume, roleExists = roleExistsCli }) {
  const problems = []
  const rows = []
  for (const account of [PREVIEW_ACCOUNT, LIVE_ACCOUNT]) {
    const control = await assume(arn(account, 'coderizehq-infra-plan'), token)
    rows.push({ role: 'coderizehq-infra-plan (control)', account, why: 'trusted: a platform PR running ci-tofu.yml at v1', result: control.assumed ? 'assumed' : control.code })
    if (!control.assumed) problems.push(`the control failed: coderizehq-infra-plan in ${account} answered ${control.code} ${control.message}; without it the refusals prove nothing`)
  }
  for (const t of targets(sites)) {
    const why = differences(claims, t.trusted)
    const result = await assume(t.arn, token)
    rows.push({ role: t.role, account: t.account, why: why.join('; ') || 'nothing (this token matches its trust)', result: result.assumed ? 'ASSUMED' : result.code })
    if (result.assumed) problems.push(`${t.role} in ${t.account} was assumed by this token: its trust lets ${claims.repository} ${claims.job_workflow_ref} in`)
    else if (result.code !== 'AccessDenied') problems.push(`${t.role} in ${t.account} answered ${result.code} (${result.message}), not AccessDenied, so it proves nothing about the policy`)
    else if (!(await roleExists(t.account, t.role))) problems.push(`${t.role} doesn't exist in ${t.account}, so its refusal proves nothing`)
    if (!why.length) problems.push(`this run's token matches ${t.role}'s trust; run the trust tests from platform pull requests only`)
  }
  return { rows, problems }
}

export function table(rows) {
  return [
    '| Role | Account | Refused because the token has | Result |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| \`${r.role}\` | ${r.account} | ${r.why} | ${r.result} |`),
  ].join('\n')
}

async function main() {
  const dir = path.resolve(process.env.SITES_DIR ?? 'sites')
  const sites = []
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.json')).sort()) sites.push(JSON.parse(await readFile(path.join(dir, f), 'utf8')))
  if (!sites.length) throw new Error(`no site records in ${dir}`)

  const token = await requestToken('sts.amazonaws.com')
  const claims = decodeClaims(token)
  const shown = ['repository', 'repository_id', 'event_name', 'ref', 'environment', 'job_workflow_ref', 'sub']
  console.log(`This job's token: ${shown.map((k) => `${k}=${claims[k] ?? '(none)'}`).join(', ')}`)

  const { rows, problems } = await probe({ claims, token, sites })
  console.log(table(rows))
  summary(`### Negative trust tests\n\n${table(rows)}`)
  if (problems.length) {
    for (const p of problems) console.log(`::error::${p}`)
    process.exit(1)
  }
  console.log(`${rows.length - 2} roles refused this token, and the control role accepted it in both accounts.`)
}

runIfMain(import.meta.url, main)

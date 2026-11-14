// ci-tofu's PR comment: one comment holding every root's read-only plan, updated in place on each push so the PR
// shows the plan for its latest commit. Each plan job leaves plans/<slug>/result.json and plans/<slug>/plan.txt.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { gh, ghAll } from './lib/github.mjs'
import { runIfMain } from './lib/report.mjs'

export const MARKER = '<!-- ci-tofu-plan -->'
const LIMIT = 60_000 // GitHub caps a comment at 65,536 characters

/** The line OpenTofu ends a plan with, or what stopped it. */
export function headline(result, text) {
  if (result.status === 'skipped') return `skipped: ${result.reason}`
  if (result.status === 'failed') return 'plan failed'
  const line = text.split('\n').find((l) => /^(Plan: |No changes\.)/.test(l.trim()))
  return line?.trim() ?? 'planned'
}

/**
 * @param {{ result: { root: string, status: 'planned' | 'failed' | 'skipped', reason?: string }, text: string }[]} plans
 * @param {string} sha
 */
export function formatComment(plans, sha) {
  const sorted = [...plans].sort((a, b) => (a.result.root < b.result.root ? -1 : 1))
  const budget = Math.floor(LIMIT / Math.max(1, sorted.length)) - 400
  const parts = [MARKER, '### OpenTofu plans', '', `Read-only plans for \`${sha.slice(0, 7)}\`, without the state lock. Nothing is applied from a PR.`]
  for (const { result, text } of sorted) {
    parts.push('', `#### \`${result.root}\`: ${headline(result, text)}`)
    if (result.status === 'skipped') continue
    let body = text.replaceAll('```', '`​``').trim()
    if (body.length > budget) body = `…(${body.length - budget} characters cut; the full plan is in the job log)\n${body.slice(-budget)}`
    parts.push('', '<details><summary>Show plan</summary>', '', '```text', body, '```', '', '</details>')
  }
  return `${parts.join('\n')}\n`
}

export async function readPlans(dir) {
  const plans = []
  for (const slug of await readdir(dir)) {
    const result = JSON.parse(await readFile(path.join(dir, slug, 'result.json'), 'utf8'))
    const text = await readFile(path.join(dir, slug, 'plan.txt'), 'utf8').catch(() => '')
    plans.push({ result, text })
  }
  return plans
}

async function main() {
  const { GH_TOKEN: token, REPO: repo, PR: pr, SHA: sha, PLANS_DIR: dir } = process.env
  const body = formatComment(await readPlans(dir), sha)
  const comments = await ghAll(token, `/repos/${repo}/issues/${pr}/comments`)
  const mine = comments.find((c) => c.user?.login === 'github-actions[bot]' && c.body?.startsWith(MARKER))
  if (mine) await gh(token, `/repos/${repo}/issues/comments/${mine.id}`, { method: 'PATCH', body: { body } })
  else await gh(token, `/repos/${repo}/issues/${pr}/comments`, { method: 'POST', body: { body } })
  console.log(`${mine ? 'updated' : 'posted'} the plan comment on #${pr}`)
}

runIfMain(import.meta.url, main)

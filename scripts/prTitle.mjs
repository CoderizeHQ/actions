// The PR-title check every shared check runs on pull requests (plan, Phase 3 "Shared workflows"; Phase 4 STANDARDS):
// the title is a Conventional Commit, `type(scope)!: summary`, because squash merges use it as the commit message and
// Release Please reads those to pick the next version and write the changelog. The summary is imperative and starts
// lowercase, with no trailing period: `feat: add the events page`, `fix(deps): update astro to v7.1.2`.

import { runIfMain, summary } from './lib/report.mjs'

export const TYPES = ['feat', 'fix', 'chore', 'docs', 'refactor', 'perf', 'test', 'build', 'ci', 'style', 'revert']

/**
 * What's wrong with a PR title, or null when it's a Conventional Commit.
 * @param {string} title
 */
export function titleProblem(title) {
  const t = String(title ?? '')
  const m = /^([a-z]+)(\([a-z0-9][a-z0-9._/-]*\))?(!)?: (.+)$/.exec(t)
  if (!m) return `"${t}" is not a Conventional Commit title: write it as type(scope): summary, for example "feat: add the events page"`
  const [, type, , , text] = m
  if (!TYPES.includes(type)) return `"${type}" is not a Conventional Commit type (${TYPES.join(', ')})`
  if (text !== text.trim()) return 'the summary has extra spaces at the start or end'
  if (!/^[a-z0-9]/.test(text)) return `the summary starts with "${text[0]}"; start it lowercase ("${type}: ${text[0].toLowerCase()}${text.slice(1)}")`
  if (text.endsWith('.')) return 'the summary ends with a period; drop it'
  return null
}

async function main() {
  const title = process.env.PR_TITLE ?? ''
  const problem = titleProblem(title)
  if (problem) {
    console.log(`::error::PR title: ${problem}`)
    summary(`### PR title\n\n${problem}`)
    process.exit(1)
  }
  console.log(`PR title "${title}" is a Conventional Commit.`)
}

runIfMain(import.meta.url, main)

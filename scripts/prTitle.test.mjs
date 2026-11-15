import assert from 'node:assert/strict'
import { test } from 'node:test'

import { titleProblem } from './prTitle.mjs'

test('Conventional Commit titles pass, including Release Please and Renovate', () => {
  for (const t of ['feat: add the events page', 'fix(deps): update dependency astro to v7.1.2', 'chore(main): release 0.2.0', 'feat!: drop the old router', 'refactor(api/v2): split the handlers', 'docs: explain v1 in the README']) {
    assert.equal(titleProblem(t), null, t)
  }
})

test('anything else fails, saying what to change', () => {
  assert.match(titleProblem('Add the events page'), /not a Conventional Commit title/)
  assert.match(titleProblem('feature: add the events page'), /"feature" is not a Conventional Commit type/)
  assert.match(titleProblem('feat: Add the events page'), /start it lowercase \("feat: add the events page"\)/)
  assert.match(titleProblem('feat: add the events page.'), /ends with a period/)
  assert.match(titleProblem('feat:add the events page'), /not a Conventional Commit title/)
  assert.match(titleProblem('feat:  add the events page'), /extra spaces/)
  assert.match(titleProblem('Feat: add'), /not a Conventional Commit title/)
  assert.match(titleProblem(''), /not a Conventional Commit title/)
})

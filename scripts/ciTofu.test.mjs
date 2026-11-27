import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// ci-tofu.yml's plan parallelism: aws/live's PR plan runs 30 at a time, as its apply.yml plan does (platform #375),
// and every other root keeps OpenTofu's default of 10.

const wf = readFileSync(new URL('../.github/workflows/ci-tofu.yml', import.meta.url), 'utf8')

// The text between two markers, each of which must be there once, so a reworded step fails here instead of quietly
// testing a different slice.
const between = (text, start, end) => {
  for (const marker of [start, end]) assert.equal(text.split(marker).length, 2, `one '${marker.trim()}' in the slice`)
  assert.ok(text.indexOf(start) < text.indexOf(end), `'${start.trim()}' comes before '${end.trim()}'`)
  return text.slice(text.indexOf(start), text.indexOf(end))
}

const plan = between(wf, '\n  plan:', '\n  comment:')
const planStep = between(plan, '- name: tofu plan', '- uses: actions/upload-artifact')
const guard = between(planStep, 'if [ "$PARALLELISM" = null ]', '# A read-only App')

const defaultRoots = () => {
  const m = /\n      roots:\n        description: .+\n        type: string\n        default: '(.+)'\n/.exec(wf)
  assert.ok(m, 'roots has a JSON default')
  return JSON.parse(m[1])
}

test('the default roots plan aws/live at 30 and leave every other root at the default', () => {
  const roots = defaultRoots()
  assert.deepEqual(roots.map((r) => r.root), ['tofu', 'aws/live', 'aws/preview', 'cloudflare/ai'])
  assert.deepEqual(Object.fromEntries(roots.map((r) => [r.root, r.parallelism])), {
    tofu: undefined,
    'aws/live': 30,
    'aws/preview': undefined,
    'cloudflare/ai': undefined,
  })
  // Nothing else about the roots moved.
  assert.deepEqual(roots.find((r) => r.root === 'aws/live'), { root: 'aws/live', account: '243891826043', parallelism: 30 })
  assert.equal(roots.find((r) => r.root === 'cloudflare/ai').offline, true)
})

test('the job gets the root\'s parallelism as JSON, with no default in the expression, and the plan alone uses it', () => {
  // toJSON keeps a missing key ("null") apart from a falsy one: `|| 10` would turn a configured 0, false or "" into 10.
  assert.match(plan, /\n      PARALLELISM: \$\{\{ toJSON\(matrix\.root\.parallelism\) \}\}\n/)
  assert.doesNotMatch(wf, /matrix\.root\.parallelism \|\|/)
  assert.match(planStep, /"\$RUNNER_TEMP\/bin\/tofu" plan -input=false -no-color -lock=false -parallelism="\$PARALLELISM" "\$\{refresh\[@\]\}"/)
  assert.doesNotMatch(between(planStep, 'tofu" init', 'tofu" plan'), /parallelism/)
  assert.equal(wf.match(/-parallelism=/g).length, 1, 'only the plan job passes -parallelism')
})

// What `toJSON(matrix.root.parallelism)` renders for a root's value, run through the step's own guard.
const run = (rendered) =>
  spawnSync('bash', ['-c', `${guard}\necho "parallelism=$PARALLELISM"`], {
    env: { ...process.env, ROOT: 'aws/live', PARALLELISM: rendered },
    encoding: 'utf8',
  })

test('the parallelism is checked before init: a missing key plans at 10, a whole number from 1 to 50 as given', () => {
  assert.ok(planStep.indexOf('if [ "$PARALLELISM" = null ]') < planStep.indexOf('tofu" init'))
  for (const [rendered, used] of [['null', '10'], ['1', '1'], ['10', '10'], ['30', '30'], ['50', '50']]) {
    const r = run(rendered)
    assert.equal(r.status, 0, `${rendered} passes`)
    assert.equal(r.stdout.trim(), `parallelism=${used}`)
  }
})

test('a set but bad parallelism fails the plan instead of quietly running at 10', () => {
  // 0, false, "" and "30" are what JSON values like 0, false, "" and "30" render as through toJSON.
  for (const bad of ['0', 'false', '""', '"30"', '51', '99', '100', '030', '-1', '30.5', '1e1', '', 'ten', '30 -refresh=false', '[30]']) {
    const r = run(bad)
    assert.equal(r.status, 1, `${bad} fails`)
    assert.match(r.stdout, /::error::aws\/live: parallelism must be a whole number from 1 to 50/)
    assert.doesNotMatch(r.stdout, /parallelism=/)
  }
})

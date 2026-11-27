import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// ci-tofu.yml's plan parallelism: aws/live's PR plan runs 30 at a time, as its apply.yml plan does (platform #375),
// and every other root keeps OpenTofu's default of 10.

const wf = readFileSync(new URL('../.github/workflows/ci-tofu.yml', import.meta.url), 'utf8')
const plan = wf.slice(wf.indexOf('\n  plan:'), wf.indexOf('\n  comment:'))
const planStep = plan.slice(plan.indexOf('- name: tofu plan'), plan.indexOf('- uses: actions/upload-artifact'))
const guard = planStep.slice(planStep.indexOf('if ! [['), planStep.indexOf('# A read-only App'))

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

test("a root without parallelism gets OpenTofu's 10, and the plan alone uses it", () => {
  assert.match(plan, /\n      PARALLELISM: \$\{\{ matrix\.root\.parallelism \|\| 10 \}\}\n/)
  assert.match(planStep, /"\$RUNNER_TEMP\/bin\/tofu" plan -input=false -no-color -lock=false -parallelism="\$PARALLELISM" "\$\{refresh\[@\]\}"/)
  assert.doesNotMatch(planStep.slice(planStep.indexOf('tofu" init'), planStep.indexOf('tofu" plan')), /parallelism/)
  assert.equal(wf.match(/-parallelism=/g).length, 1, 'only the plan job passes -parallelism')
})

test('the parallelism is checked before init, and anything but 1 to 50 fails the plan', () => {
  assert.ok(guard.length > 0, 'the plan step checks the parallelism')
  assert.ok(planStep.indexOf('if ! [[') < planStep.indexOf('tofu" init'))
  const run = (value) => spawnSync('bash', ['-c', guard], { env: { ...process.env, ROOT: 'aws/live', PARALLELISM: value }, encoding: 'utf8' })
  for (const ok of ['1', '10', '30', '50']) assert.equal(run(ok).status, 0, `${ok} passes`)
  for (const bad of ['0', '51', '99', '100', '030', '-1', '', '30 -refresh=false', '1e1', 'ten']) {
    const r = run(bad)
    assert.equal(r.status, 1, `'${bad}' fails`)
    assert.match(r.stdout, /::error::aws\/live: parallelism must be a whole number from 1 to 50/)
  }
})

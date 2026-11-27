import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// ci-node.yml's opt-in Go toolchain: with go-version-file, the input is checked and actions/setup-go runs before the
// install, ESLint and tests; without it, the job runs the same steps as before.

const wf = readFileSync(new URL('../.github/workflows/ci-node.yml', import.meta.url), 'utf8')

// The text between two markers, each of which must be there once, so a reworded step fails here instead of quietly
// testing a different slice.
const between = (text, start, end) => {
  for (const marker of [start, end]) assert.equal(text.split(marker).length, 2, `one '${marker.trim()}' in the slice`)
  assert.ok(text.indexOf(start) < text.indexOf(end), `'${start.trim()}' comes before '${end.trim()}'`)
  return text.slice(text.indexOf(start), text.indexOf(end))
}

const checkStep = between(wf, '- name: Check the Go input', '- name: Setup Go')
const setupStep = between(wf, '- name: Setup Go', '- name: Install')
const guard = checkStep.slice(checkStep.indexOf('run: |') + 'run: |'.length)

const GATE = "if: inputs.go-version-file != ''"

test('go-version-file is an optional string input, empty by default', () => {
  assert.match(wf, /\n      go-version-file:\n        type: string\n        default: ''\n/)
  assert.doesNotMatch(between(wf, '\n      go-version-file:\n', '\npermissions:'), /required: true/)
})

test('setup-go is pinned to a full commit SHA with its version, and used once', () => {
  const uses = wf.match(/uses: actions\/setup-go@.*/g)
  assert.equal(uses.length, 1, 'one setup-go step')
  assert.match(uses[0], /^uses: actions\/setup-go@[0-9a-f]{40} # v\d+\.\d+\.\d+$/)
  assert.match(setupStep, /\n        uses: actions\/setup-go@[0-9a-f]{40} # v\d+\.\d+\.\d+\n/)
})

test('both Go steps run only with go-version-file, and nothing else reads it', () => {
  assert.ok(checkStep.includes(`\n        ${GATE}\n`), 'the check is gated on the input')
  assert.ok(setupStep.includes(`\n        ${GATE}\n`), 'setup-go is gated on the input')
  assert.equal(wf.split(GATE).length, 3, 'exactly the two Go steps carry the gate')
  // The input's own declaration, the check's env and setup-go's go-version-file: no other step depends on it.
  assert.equal(wf.match(/inputs\.go-version-file/g).length, 4)
  // The check's outputs reach setup-go alone.
  assert.deepEqual(wf.match(/steps\.go\.outputs\.[a-z-]+/g), setupStep.match(/steps\.go\.outputs\.[a-z-]+/g))
  assert.deepEqual(setupStep.match(/steps\.go\.outputs\.[a-z-]+/g), ['steps.go.outputs.cache', 'steps.go.outputs.go-sum'])
})

test('setup-go reads the go.mod in the checkout, and caches on the go.sum the check found', () => {
  assert.match(setupStep, /\n          go-version-file: repo\/\$\{\{ inputs\.go-version-file \}\}\n/)
  assert.match(setupStep, /\n          cache: \$\{\{ steps\.go\.outputs\.cache \}\}\n/)
  assert.match(setupStep, /\n          cache-dependency-path: \$\{\{ steps\.go\.outputs\.go-sum \}\}\n/)
  assert.match(checkStep, /\n        id: go\n/)
  assert.match(checkStep, /\n        working-directory: repo\n/)
  // The input reaches the shell through env only, never spliced into the script.
  assert.match(checkStep, /\n          GO_MOD: \$\{\{ inputs\.go-version-file \}\}\n/)
  assert.doesNotMatch(guard, /\$\{\{/)
})

test('Go is set up after the checks on committed files and before the install, ESLint and tests', () => {
  const at = (marker) => {
    assert.equal(wf.split(marker).length, 2, `one '${marker}'`)
    return wf.indexOf(marker)
  }
  const order = [
    '- name: gitleaks (full history)',
    '- name: Dependency audit',
    '- name: Check the Go input',
    '- name: Setup Go',
    '- name: Install',
    '- name: ESLint',
    '- name: Tests',
  ].map(at)
  assert.deepEqual([...order].sort((a, b) => a - b), order)
})

test('no step is skipped on a cache hit', () => {
  // Fleet lesson: an install gated on cache-hit leaves the job without its dependencies when the cache is partial.
  assert.doesNotMatch(wf, /cache-hit/)
})

test('without go-version-file the job and its other steps are what they were', () => {
  const jobs = between(wf, '\njobs:\n', '\n    steps:\n')
  assert.deepEqual([...jobs.matchAll(/\n  ([a-z0-9-]+):\n/g)].map((m) => m[1]), ['ci-node'])
  // Each step, from its `- ` line to the next one, by its name (or the action it uses) and its own `if:`.
  const steps = wf
    .slice(wf.indexOf('\n    steps:\n'))
    .split('\n      - ')
    .slice(1)
    .map((s) => ({
      name: /^name: (.+)$/m.exec(s)?.[1] ?? /^uses: ([^@]+)@/m.exec(s)[1],
      if: /^        if: (.+)$/m.exec(s)?.[1],
    }))
  assert.deepEqual(
    steps.filter((s) => s.if === "inputs.go-version-file != ''").map((s) => s.name),
    ['Check the Go input', 'Setup Go'],
  )
  const ungated = steps.filter((s) => s.if !== "inputs.go-version-file != ''").map((s) => s.name)
  assert.deepEqual(ungated, [
    'actions/checkout',
    "Find this workflow's commit",
    'actions/checkout',
    'Setup pnpm and Node',
    'PR title is a Conventional Commit',
    'gitleaks (full history)',
    'Dependency audit',
    'Install',
    'ESLint',
    'Test database',
    'Tests',
    'Drop the test database',
  ])
})

// The check step's own script, run in a temporary repo with the files a test names.
const run = (goMod, files = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-node-go-'))
  try {
    for (const f of files) {
      mkdirSync(join(dir, f, '..'), { recursive: true })
      writeFileSync(join(dir, f), '')
    }
    const out = join(dir, 'github-output')
    writeFileSync(out, '')
    const r = spawnSync('bash', ['-c', guard], {
      cwd: dir,
      env: { ...process.env, GO_MOD: goMod, GITHUB_OUTPUT: out },
      encoding: 'utf8',
    })
    return { ...r, output: readFileSync(out, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a go.mod in the repo passes, and the cache is keyed on the go.sum beside it', () => {
  for (const [goMod, sum] of [
    ['apps/desktop/go.mod', 'repo/apps/desktop/go.sum'],
    ['go.mod', 'repo/go.sum'],
    ['apps/my_app-2/v1.2/go.mod', 'repo/apps/my_app-2/v1.2/go.sum'],
  ]) {
    const r = run(goMod, [goMod, sum.slice('repo/'.length)])
    assert.equal(r.status, 0, `${goMod} passes: ${r.stdout}`)
    assert.equal(r.output, `go-sum=${sum}\ncache=true\n`)
  }
})

test('with no go.sum beside the go.mod the cache is off, and the step still passes', () => {
  const r = run('apps/desktop/go.mod', ['apps/desktop/go.mod', 'go.sum'])
  assert.equal(r.status, 0)
  assert.equal(r.output, 'go-sum=repo/apps/desktop/go.sum\ncache=false\n')
})

test('a path that is not a relative path to a go.mod in the repo fails before setup-go', () => {
  for (const bad of [
    '/apps/desktop/go.mod',
    '/go.mod',
    '../go.mod',
    'apps/../go.mod',
    'apps/desktop/../../go.mod',
    './go.mod',
    'apps/./desktop/go.mod',
    '.hidden/go.mod',
    'apps//go.mod',
    'apps/desktop/',
    'apps/desktop',
    'apps/desktop/go.sum',
    'apps/desktop/foogo.mod',
    'apps/desktop/go.mod/',
    'apps/desktop/go.work',
    'apps/desk top/go.mod',
    'apps/desktop/go.mod; true',
    'apps/$(id)/go.mod',
    '~/go.mod',
    'C:\\repo\\go.mod',
  ]) {
    const r = run(bad, ['go.mod', 'apps/desktop/go.mod'])
    assert.equal(r.status, 1, `${bad} fails`)
    assert.match(r.stdout, /::error::go-version-file is a relative path to a go.mod in the repo/)
    assert.equal(r.output, '', `${bad} sets no output`)
  }
})

test('a well-formed path to a go.mod the repo does not have fails', () => {
  const r = run('apps/web/go.mod', ['apps/desktop/go.mod'])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /::error::go-version-file: the repo has no apps\/web\/go.mod/)
  assert.equal(r.output, '')
})

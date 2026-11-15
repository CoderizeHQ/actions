import assert from 'node:assert/strict'
import { test } from 'node:test'

import { auditConfigProblems, judgeAudit, readIgnores } from './auditCheck.mjs'

const TODAY = '2026-11-14'
const ok = { id: 'GHSA-29mw-wpgm-hmr9', reason: 'only the build uses it; nothing reaches the shipped site', expires: '2026-12-31' }

test('an ignore needs an advisory id, a reason and a date that has not passed', () => {
  assert.deepEqual(readIgnores([ok], TODAY), { ids: new Set([ok.id]), problems: [] })
  assert.match(readIgnores([{ ...ok, id: 'CVE-2020-8203' }], TODAY).problems[0], /GitHub advisory id/)
  assert.match(readIgnores([{ ...ok, reason: '' }], TODAY).problems[0], /needs a reason/)
  assert.match(readIgnores([{ ...ok, expires: undefined }], TODAY).problems[0], /needs an expiry date/)
  assert.match(readIgnores([{ ...ok, expires: '31/12/2026' }], TODAY).problems[0], /needs an expiry date/)
  assert.match(readIgnores([{ ...ok, expires: '2026-11-13' }], TODAY).problems[0], /expired on 2026-11-13/)
  assert.deepEqual(readIgnores([{ ...ok, expires: TODAY }], TODAY).problems, []) // the last day still counts
  assert.match(readIgnores([ok, ok], TODAY).problems[0], /listed twice/)
  assert.match(readIgnores({ ignore: [] }, TODAY).problems[0], /must be a JSON array/)
})

test("pnpm's own audit ignores are refused", () => {
  assert.deepEqual(auditConfigProblems({ pnpm: {} }, 'packages:\n  - apps/*\n'), [])
  assert.equal(auditConfigProblems({ pnpm: { auditConfig: { ignoreGhsas: ['GHSA-x'] } } }, 'auditConfig:\n  ignoreCves: []\n').length, 2)
})

test('moderate and above fail unless ignored; low and info never do', () => {
  const advisory = (id, severity) => ({ github_advisory_id: id, severity, module_name: 'lodash', title: 't', patched_versions: '>=4.17.21', findings: [{ version: '4.17.20' }] })
  const report = {
    advisories: {
      1: advisory('GHSA-29mw-wpgm-hmr9', 'moderate'),
      2: advisory('GHSA-35jh-r3h4-6jhm', 'high'),
      3: advisory('GHSA-p6mc-m468-83gw', 'low'),
    },
  }
  const r = judgeAudit(report, new Set(['GHSA-29mw-wpgm-hmr9', 'GHSA-jf85-cpcp-j695']))
  assert.equal(r.failing.length, 1)
  assert.match(r.failing[0], /lodash 4\.17\.20: GHSA-35jh-r3h4-6jhm \[high\]/)
  assert.equal(r.skipped.length, 1)
  assert.deepEqual(r.unused, ['GHSA-jf85-cpcp-j695'])
  assert.deepEqual(judgeAudit({ advisories: {} }, new Set()), { failing: [], skipped: [], unused: [] })
})

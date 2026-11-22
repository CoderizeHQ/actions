// rebuild-target.yml's one step (lib/rebuild.mjs has the whole flow): checks the content-rebuild dispatch, or a data
// refresh's data-refresh dispatch, and finds the commit to rebuild, the one live runs now, through GitHub's API (no
// AWS). Its outputs go to deploy-preview.yml's `rebuild-commit` (a content rebuild) or refresh-build.yml's `commit` (a
// data refresh), which build exactly that commit; release.yml then finds the same target again on its own, and refuses
// if the two differ.
//
// `node rebuild.mjs target`

import { checkSha } from './lib/build.mjs'
import { CONTENT_REBUILD, DATA_REFRESH, describeRefresh, describeTarget, dispatchProblems, findTarget, refreshDispatchProblems } from './lib/rebuild.mjs'
import { output, runIfMain, summary } from './lib/report.mjs'
import { deploymentEnvironment } from './release.mjs'

/**
 * @returns {Promise<{ ok: true, sha: string, basis: string, tag: string | null, contentSha256?: string, refresh?: boolean,
 *   reason?: string } | { ok: false, reasons: string[] }>}
 */
export async function target({ token, repo, ref, event, dispatch, sender, site, payloadSite, payloadContent, payloadReason, environment, find = findTarget }) {
  if (event === 'repository_dispatch' && dispatch === DATA_REFRESH.action) {
    const reasons = refreshDispatchProblems({ ref, sender, site, payloadSite, payloadReason })
    if (reasons.length) return { ok: false, reasons }
    const t = await find({ token, repo, environment: deploymentEnvironment(site, environment), refresh: true })
    if (!t.ok) return t
    return { ok: true, sha: t.sha, basis: t.basis, tag: t.tag, refresh: true, reason: payloadReason }
  }
  if (event !== 'repository_dispatch' || dispatch !== CONTENT_REBUILD.action) {
    return {
      ok: false,
      reasons: [`rebuild-target runs only for the repository_dispatch ${CONTENT_REBUILD.action} or ${DATA_REFRESH.action}, not ${String(event)} ${String(dispatch ?? '')}`.trim()],
    }
  }
  const reasons = dispatchProblems({ ref, sender, site, payloadSite, payloadContent })
  if (reasons.length) return { ok: false, reasons }
  const t = await find({ token, repo, environment: deploymentEnvironment(site, environment) })
  if (!t.ok) return t
  return { ok: true, sha: t.sha, basis: t.basis, tag: t.tag, contentSha256: payloadContent }
}

runIfMain(import.meta.url, async () => {
  const env = process.env
  if (process.argv[2] !== 'target') throw new Error('usage: rebuild.mjs target')
  if (!env.GH_TOKEN || !env.REPO) throw new Error('GH_TOKEN and REPO must be set')
  const t = await target({
    token: env.GH_TOKEN,
    repo: env.REPO,
    ref: env.REF,
    event: env.EVENT,
    dispatch: env.DISPATCH,
    sender: env.SENDER,
    site: env.SITE,
    payloadSite: env.PAYLOAD_SITE,
    payloadContent: env.PAYLOAD_CONTENT,
    payloadReason: env.PAYLOAD_REASON,
    environment: env.DEPLOYMENT,
  })
  if (!t.ok) {
    for (const r of t.reasons) console.log(`::error::${r}`)
    summary(`### Content rebuild refused\n\n${t.reasons.map((r) => `- ${r}`).join('\n')}`)
    process.exit(1)
  }
  output('commit', checkSha(t.sha))
  output('content-sha256', t.contentSha256 ?? '')
  const why = t.refresh ? describeRefresh(t) : describeTarget(t)
  console.log(`${why}: building ${t.sha}`)
  summary(`### ${t.refresh ? 'Data refresh' : 'Content rebuild'}\n\n${why}: building \`${t.sha}\`, the commit live runs now.`)
})

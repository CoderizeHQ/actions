// The `review` check until the review service is live (Phase 5). Runs from review-stub.yml as the coderizehq-reviewer
// App and posts one `review` check run on the head commit of every open PR in CoderizeHQ:
// - risky PRs wait until James has approved at the head commit;
// - Renovate's own lockfile-only updates are skipped;
// - everything else passes.
// Risk is decided from changed files, the author, the branch and the repo, never from labels, title or body (anyone
// with write access can edit those). actions is public, so this logs counts only, never repo names or PR titles.

export const JAMES_ID = 74272118 // GilbertJames
export const RENOVATE_ID = 29139614 // renovate[bot]
export const REVIEWER_APP_ID = 5761471 // coderizehq-reviewer

// The same paths each site's CODEOWNERS gives James (plan, Phase 1 "Merge rules").
const RISKY_PATHS = [
  /^\.github\//,
  /^renovate\.json$/,
  /^package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^\.npmrc$/,
  /^\.pnpmfile\.cjs$/,
  /^patches\//,
  /^\.claude\//,
  /^CLAUDE\.md$/,
  /^AGENTS\.md$/,
  /^CHANGELOG\.md$/,
  /^\.release-please-manifest\.json$/,
  /^release-please-config\.json$/,
]

/** @param {string} repo */
export const isSiteRepo = (repo) => repo.endsWith('-web') || repo === 'site-template'

/**
 * Decides the `review` result for one PR.
 * @param {{ repo: string, authorId: number, headRef: string, headSha: string, files: string[],
 *   commitAuthorIds: (number|null)[], reviews: { userId: number, state: string, commitId: string }[] }} pr
 * @returns {{ status: 'completed'|'in_progress', conclusion?: 'success'|'skipped', title: string }}
 */
export function decide(pr) {
  const renovateLockfileOnly =
    pr.authorId === RENOVATE_ID &&
    pr.headRef.startsWith('renovate/') &&
    pr.files.length > 0 &&
    pr.files.every((f) => f === 'pnpm-lock.yaml') &&
    pr.commitAuthorIds.length > 0 &&
    pr.commitAuthorIds.every((id) => id === RENOVATE_ID)
  if (renovateLockfileOnly) return { status: 'completed', conclusion: 'skipped', title: 'Renovate lockfile update' }

  const risky =
    !isSiteRepo(pr.repo) ||
    pr.headRef.startsWith('release-please--') ||
    pr.files.some((f) => RISKY_PATHS.some((re) => re.test(f)))
  if (!risky) return { status: 'completed', conclusion: 'success', title: 'Not risky' }

  // James's latest review on the current head commit decides; a review on an older commit doesn't count.
  const atHead = pr.reviews.filter((r) => r.userId === JAMES_ID && r.commitId === pr.headSha)
  const latest = atHead.at(-1)
  if (latest?.state === 'APPROVED') return { status: 'completed', conclusion: 'success', title: 'Approved by James' }
  return { status: 'in_progress', title: 'Needs James’s approval at the latest commit' }
}

const API = 'https://api.github.com'

async function gh(token, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path.split('?')[0].replace(/\/repos\/[^/]+\/[^/]+/, '/repos/…')}: ${res.status}`)
  return res.status === 204 ? null : res.json()
}

async function paged(token, path, key) {
  const out = []
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?'
    const body = await gh(token, `${path}${sep}per_page=100&page=${page}`)
    const items = key ? body[key] : body
    out.push(...items)
    if (items.length < 100) return out
  }
}

async function main() {
  const token = process.env.GH_TOKEN
  if (!token) throw new Error('GH_TOKEN is not set')
  const repos = await paged(token, '/installation/repositories', 'repositories')
  const counts = { prs: 0, waiting: 0, passed: 0, skipped: 0, updated: 0 }

  for (const repo of repos) {
    if (repo.archived) continue
    const full = repo.full_name
    const pulls = await paged(token, `/repos/${full}/pulls?state=open`)
    for (const pull of pulls) {
      counts.prs++
      const [files, commits, reviews] = await Promise.all([
        paged(token, `/repos/${full}/pulls/${pull.number}/files`),
        paged(token, `/repos/${full}/pulls/${pull.number}/commits`),
        paged(token, `/repos/${full}/pulls/${pull.number}/reviews`),
      ])
      const result = decide({
        repo: repo.name,
        authorId: pull.user.id,
        headRef: pull.head.ref,
        headSha: pull.head.sha,
        files: files.map((f) => f.filename),
        commitAuthorIds: commits.map((c) => c.author?.id ?? null),
        reviews: reviews.map((r) => ({ userId: r.user?.id, state: r.state, commitId: r.commit_id })),
      })
      if (result.status === 'in_progress') counts.waiting++
      else if (result.conclusion === 'skipped') counts.skipped++
      else counts.passed++

      const existing = await gh(
        token,
        `/repos/${full}/commits/${pull.head.sha}/check-runs?check_name=review&app_id=${REVIEWER_APP_ID}`,
      )
      const run = existing.check_runs[0]
      if (run && run.status === result.status && (run.conclusion ?? undefined) === result.conclusion) continue
      const body = {
        status: result.status,
        ...(result.conclusion ? { conclusion: result.conclusion } : {}),
        output: { title: result.title, summary: result.title },
      }
      // A completed run is never reopened; a new one replaces it (GitHub counts the latest run of a name).
      if (run && run.status !== 'completed')
        await gh(token, `/repos/${full}/check-runs/${run.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      else
        await gh(token, `/repos/${full}/check-runs`, {
          method: 'POST',
          body: JSON.stringify({ name: 'review', head_sha: pull.head.sha, ...body }),
        })
      counts.updated++
    }
  }
  console.log(
    `${repos.length} repos, ${counts.prs} open PRs: ${counts.passed} passed, ${counts.waiting} waiting for James, ` +
      `${counts.skipped} skipped; ${counts.updated} check runs written`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}

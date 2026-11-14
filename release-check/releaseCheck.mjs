// The first version of the `release` check (plan, Phase 1 hard gate; the deploy gate in Phase 3 builds on it).
// A release passes only if:
// - its GitHub release was made by the coderizehq-release App;
// - the tagged commit is the squash of a merged release-please-- PR;
// - James approved that PR at its head commit;
// - the PR changed only CHANGELOG.md, .release-please-manifest.json and the `version` line of package.json.
// A release PR merged through James's bypass without an approval is refused on purpose.

export const JAMES_ID = 74272118 // GilbertJames
export const RELEASE_BOT_ID = 356725100 // coderizehq-release[bot]

const RELEASE_FILES = new Set(['CHANGELOG.md', '.release-please-manifest.json', 'package.json'])

/**
 * @param {{ sha: string,
 *   release: { authorId: number } | null,
 *   pr: { merged: boolean, mergeSha: string, headRef: string, headSha: string } | null,
 *   reviews: { userId: number, state: string, commitId: string }[],
 *   files: { name: string, patch?: string }[] }} facts
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function decide(facts) {
  const reasons = []
  if (!facts.release) reasons.push('no GitHub release for this tag')
  else if (facts.release.authorId !== RELEASE_BOT_ID) reasons.push('the release was not made by the release App')

  const pr = facts.pr
  if (!pr) reasons.push('the commit is not the merge of a pull request')
  else {
    if (!pr.merged || pr.mergeSha !== facts.sha) reasons.push('the commit is not the merge of that pull request')
    if (!pr.headRef.startsWith('release-please--')) reasons.push('the pull request is not a Release Please PR')
    const atHead = facts.reviews.filter((r) => r.userId === JAMES_ID && r.commitId === pr.headSha)
    if (atHead.at(-1)?.state !== 'APPROVED') reasons.push('James did not approve the release PR at its head commit')
  }

  for (const f of facts.files) {
    if (!RELEASE_FILES.has(f.name)) reasons.push(`unexpected file in the release PR: ${f.name}`)
    else if (f.name === 'package.json' && !onlyVersionChanged(f.patch)) {
      reasons.push('package.json changed more than its version')
    }
  }
  return { ok: reasons.length === 0, reasons }
}

/** @param {string | undefined} patch */
export function onlyVersionChanged(patch) {
  if (!patch) return false
  const changed = patch.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
  return changed.length > 0 && changed.every((l) => /^[+-]\s*"version":\s*"[^"]+",?\s*$/.test(l))
}

const API = 'https://api.github.com'

async function gh(token, path) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`)
  return res.json()
}

async function main() {
  const { GH_TOKEN: token, REPO: repo, REF: ref } = process.env
  if (!token || !repo || !ref) throw new Error('GH_TOKEN, REPO and REF must be set')

  const commit = await gh(token, `/repos/${repo}/commits/${encodeURIComponent(ref)}`)
  if (!commit) throw new Error(`no commit for ${ref}`)
  const sha = commit.sha
  const tag = ref.replace(/^refs\/tags\//, '')
  const release = await gh(token, `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)
  const pulls = (await gh(token, `/repos/${repo}/commits/${sha}/pulls`)) ?? []
  const pull = pulls.find((p) => p.merge_commit_sha === sha) ?? null

  let reviews = []
  let files = []
  if (pull) {
    reviews = (await gh(token, `/repos/${repo}/pulls/${pull.number}/reviews?per_page=100`)) ?? []
    files = (await gh(token, `/repos/${repo}/pulls/${pull.number}/files?per_page=100`)) ?? []
  }

  const result = decide({
    sha,
    release: release ? { authorId: release.author?.id } : null,
    pr: pull
      ? { merged: Boolean(pull.merged_at), mergeSha: pull.merge_commit_sha, headRef: pull.head.ref, headSha: pull.head.sha }
      : null,
    reviews: reviews.map((r) => ({ userId: r.user?.id, state: r.state, commitId: r.commit_id })),
    files: files.map((f) => ({ name: f.filename, patch: f.patch })),
  })

  if (result.ok) console.log(`release ${tag} (${sha}) accepted`)
  else {
    for (const r of result.reasons) console.log(`::error::${r}`)
    console.log(`release ${tag} (${sha}) refused`)
    process.exit(1)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}

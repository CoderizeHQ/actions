// The stored build and its manifest (platform's site contract), and the plan for syncing a folder to match a build.
// Pure functions only; deployPreview.mjs and release.mjs do the S3 calls.

export const PREVIEW_ACCOUNT = '798070830797'
export const LIVE_ACCOUNT = '243891826043'
export const PREVIEW_BUCKET = `coderizehq-previews-${PREVIEW_ACCOUNT}`
// The one preview distribution answering *.preview.coderize.dev (contract, "Accounts and existing pieces").
export const PREVIEW_DISTRIBUTION = 'ENVVLCNVOIDL8'

// At most 38 characters: coderizehq-preview-deploy-<site> must fit IAM's 64-character role names.
const SITE = /^[a-z0-9-]{1,38}$/
const SHA = /^[0-9a-f]{40}$/

/** `site` is the domain with dots as hyphens; it names folders, roles and the live bucket. */
export function checkSite(site) {
  if (!SITE.test(site ?? '')) throw new Error(`not a site name: ${JSON.stringify(site)}`)
  return site
}

export function checkSha(sha, what = 'commit') {
  if (!SHA.test(sha ?? '')) throw new Error(`not a 40-character ${what} SHA: ${JSON.stringify(sha)}`)
  return sha
}

export const previewRoleArn = (site) => `arn:aws:iam::${PREVIEW_ACCOUNT}:role/coderizehq-preview-deploy-${checkSite(site)}`
export const liveRoleArn = (site) => `arn:aws:iam::${LIVE_ACCOUNT}:role/coderizehq-live-publish-${checkSite(site)}`
export const liveBucket = (site) => `coderizehq-live-${checkSite(site)}`

// The stored build: _builds/<site>/<commit>/manifest.json, with the files under files/. The contract puts files and
// manifest side by side; a build with its own root manifest.json (a web app manifest) would then collide with the
// build manifest, so files sit one folder down. IAM is unaffected: every grant is on _builds/<site>/*.
export const buildPrefix = (site, commit) => `_builds/${checkSite(site)}/${checkSha(commit)}/`
export const manifestKey = (site, commit) => `${buildPrefix(site, commit)}manifest.json`
export const storedKey = (site, commit, file) => `${buildPrefix(site, commit)}files/${file}`
export const previewPrefix = (site) => `sites/${checkSite(site)}/`
// The router rewrites <site>.preview.coderize.dev/<path> to /sites/<site>/<path> before the cache, so this clears one
// site's cached pages and nobody else's.
export const previewInvalidationPath = (site) => `/${previewPrefix(site)}*`

/**
 * @param {{ site: string, repo: string, commit: string, workflowSha: string, lockfileSha256: string,
 *   created: string, files: { path: string, size: number, sha256: string }[] }} b
 */
export function makeManifest(b) {
  const files = {}
  for (const f of b.files) files[f.path] = { size: f.size, sha256: f.sha256 }
  return {
    version: 1,
    site: checkSite(b.site),
    repo: b.repo,
    commit: checkSha(b.commit),
    workflow_sha: checkSha(b.workflowSha, 'workflow'),
    lockfile_sha256: b.lockfileSha256,
    created: b.created,
    files,
  }
}

/**
 * Checks a stored manifest belongs to this site, repo and commit and is well-formed.
 * @returns {{ path: string, size: number, sha256: string }[]} its files, sorted
 */
export function readManifest(manifest, { site, repo, commit }) {
  const problems = []
  if (manifest?.version !== 1) problems.push(`manifest version ${manifest?.version} is not 1`)
  if (manifest?.site !== site) problems.push(`manifest is for site ${manifest?.site}, not ${site}`)
  if (manifest?.repo !== repo) problems.push(`manifest is for repo ${manifest?.repo}, not ${repo}`)
  if (manifest?.commit !== commit) problems.push(`manifest is for commit ${manifest?.commit}, not ${commit}`)
  const entries = Object.entries(manifest?.files ?? {})
  if (entries.length === 0) problems.push('manifest lists no files')
  for (const [file, f] of entries) {
    if (!Number.isInteger(f?.size) || !/^[0-9a-f]{64}$/.test(f?.sha256 ?? '')) problems.push(`bad entry for ${file}`)
  }
  if (problems.length) throw new Error(problems.join('; '))
  return entries.map(([file, f]) => ({ path: file, size: f.size, sha256: f.sha256 })).sort((a, b) => (a.path < b.path ? -1 : 1))
}

/**
 * What to copy and delete so `current` (keys relative to the folder, with their ETags) matches the build.
 * @param {{ path: string, etag: string }[]} build each build file with its stored ETag (its MD5)
 * @param {{ key: string, etag: string }[]} current
 */
export function planSync(build, current) {
  const have = new Map(current.map((c) => [c.key, c.etag]))
  const want = new Set(build.map((b) => b.path))
  return {
    copies: build.filter((b) => have.get(b.path) !== b.etag).map((b) => b.path),
    deletes: current.filter((c) => !want.has(c.key)).map((c) => c.key),
    unchanged: build.filter((b) => have.get(b.path) === b.etag).length,
  }
}

// The mass-delete guard: a deploy that would delete more than this share of what's there is refused. A broken build
// that outputs one page must not empty a site. Small deletions always pass, so a small site can still lose a page.
export const DEFAULT_MAX_DELETE_SHARE = 0.25
export const DELETE_FLOOR = 10

/** @returns {string | null} the reason to refuse, or null */
export function deleteGuard({ current, deletes, maxShare = DEFAULT_MAX_DELETE_SHARE }) {
  if (!(maxShare >= 0 && maxShare <= 1)) return `max-delete-share must be between 0 and 1 (got ${maxShare})`
  if (deletes <= DELETE_FLOOR || deletes <= current * maxShare) return null
  return (
    `would delete ${deletes} of ${current} files (more than ${Math.round(maxShare * 100)}%); refusing. ` +
    "If that's intended, raise max-delete-share in the site's workflow for one run"
  )
}

/** Runs `fn` over `items` with at most `limit` in flight; rejects on the first failure. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

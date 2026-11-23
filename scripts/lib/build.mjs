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

// A content rebuild (platform's `rebuild` record field, its README "Content rebuilds"): the commit live already runs,
// built again because what its build fetches has changed. The first build of a commit can't be stored twice, so each
// rebuild is stored, write-once like any build, in a folder of its own under that commit's, named for the workflow run
// that built it (the site's rebuild workflow, whose deploy-preview and release jobs share the run id):
// _builds/<site>/<commit>/rebuilds/<run>/, its files under files/ and manifest.json beside them. IAM is unaffected:
// every grant is on _builds/<site>/*.
const RUN = /^[1-9]\d{0,19}$/

/** A workflow run id, as the rebuild folder's name. */
export function checkRun(run) {
  if (!RUN.test(String(run ?? ''))) throw new Error(`not a workflow run id: ${JSON.stringify(run)}`)
  return String(run)
}

export const rebuildPrefix = (site, commit, run) => `${buildPrefix(site, commit)}rebuilds/${checkRun(run)}/`

// A data refresh (platform's `refresh` record field, its README "Data refreshes"): the commit live runs now, or the
// commit a release has just approved, built again with a feed's secrets (refresh-build.yml) so its feed data is fresh.
// It is stored the same way, beside the commit's first build, in a folder named for the run that built it:
// _builds/<site>/<commit>/refreshes/<run>/. IAM is unaffected: every grant is on _builds/<site>/*.
export const refreshPrefix = (site, commit, run) => `${buildPrefix(site, commit)}refreshes/${checkRun(run)}/`

/**
 * Which stored build of a commit, as the key helpers below take it: null (the commit's own), a run id (a content
 * rebuild's), or a data refresh's, made by refreshRef(run).
 */
export const refreshRef = (run) => ({ refresh: checkRun(run) })
export const isRefreshRef = (ref) => typeof ref === 'object' && ref !== null
const prefixOf = (site, commit, ref) =>
  !ref ? buildPrefix(site, commit) : isRefreshRef(ref) ? refreshPrefix(site, commit, ref.refresh) : rebuildPrefix(site, commit, ref)

/** The stored build's folder: the commit's own, or, with `rebuild` (a run id), that content rebuild's, or a refresh's. */
export const storedPrefix = (site, commit, rebuild = null) => prefixOf(site, commit, rebuild)
export const manifestKey = (site, commit, rebuild = null) => `${prefixOf(site, commit, rebuild)}manifest.json`
export const storedKey = (site, commit, file, rebuild = null) => `${prefixOf(site, commit, rebuild)}files/${file}`
export const previewPrefix = (site) => `sites/${checkSite(site)}/`
// The router rewrites <site>.preview.coderize.dev/<path> to /sites/<site>/<path> before the cache, so this clears one
// site's cached pages and nobody else's.
export const previewInvalidationPath = (site) => `/${previewPrefix(site)}*`

/** A content hash, as platform's content check sends it: SHA-256 in hex. */
export const CONTENT_SHA256 = /^[0-9a-f]{64}$/

/**
 * @param {{ site: string, repo: string, commit: string, workflowSha: string, lockfileSha256: string,
 *   created: string, files: { path: string, size: number, sha256: string }[],
 *   rebuild?: { run: string, contentSha256: string | null } | null, refresh?: { run: string } | null }} b `rebuild`: a
 *   content rebuild's run and the content hash platform sent; `refresh`: a data refresh's run (the manifest says which
 *   it is; a commit's first build has neither field)
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
    ...(b.rebuild ? { rebuild: { run: checkRun(b.rebuild.run), content_sha256: b.rebuild.contentSha256 ?? null } } : {}),
    ...(b.refresh ? { refresh: { run: checkRun(b.refresh.run) } } : {}),
    files,
  }
}

/**
 * Checks a stored manifest belongs to this site, repo and commit (and, with `rebuild`, to that content rebuild's run,
 * or to a refreshRef's data refresh) and is well-formed.
 * @returns {{ path: string, size: number, sha256: string }[]} its files, sorted
 */
export function readManifest(manifest, { site, repo, commit, rebuild = null }) {
  const problems = []
  if (manifest?.version !== 1) problems.push(`manifest version ${manifest?.version} is not 1`)
  if (manifest?.site !== site) problems.push(`manifest is for site ${manifest?.site}, not ${site}`)
  if (manifest?.repo !== repo) problems.push(`manifest is for repo ${manifest?.repo}, not ${repo}`)
  if (manifest?.commit !== commit) problems.push(`manifest is for commit ${manifest?.commit}, not ${commit}`)
  const rebuildRun = rebuild && !isRefreshRef(rebuild) ? String(rebuild) : null
  const refreshRun = isRefreshRef(rebuild) ? String(rebuild.refresh) : null
  if ((manifest?.rebuild?.run ?? null) !== rebuildRun) {
    problems.push(rebuildRun ? `manifest isn't content rebuild ${rebuildRun}'s` : 'manifest is a content rebuild, not the commit\'s own build')
  }
  if ((manifest?.refresh?.run ?? null) !== refreshRun) {
    problems.push(refreshRun ? `manifest isn't data refresh ${refreshRun}'s` : 'manifest is a data refresh, not the commit\'s own build')
  }
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

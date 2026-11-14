// deploy-preview's publish step (plan, Phase 3 "Shared workflows"; platform's site contract). Runs as the site's
// coderizehq-preview-deploy-<site> role, after the build job has built the commit without any credentials:
// 1. stores the build write-once under _builds/<site>/<commit>/ (every write is If-None-Match: *), or reuses the
//    complete build already stored for that commit, which is what release will publish;
// 2. writes manifest.json last, so a manifest means a complete build;
// 3. checks every stored file against the manifest (size and S3's own SHA-256);
// 4. when the commit is still main's head, copies the stored build into sites/<site>/ server-side, deletes what the
//    build no longer has (refusing a mass delete), and clears the preview cache only if something changed.

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  buildPrefix,
  checkSha,
  checkSite,
  DEFAULT_MAX_DELETE_SHARE,
  deleteGuard,
  makeManifest,
  manifestKey,
  planSync,
  pool,
  PREVIEW_BUCKET,
  PREVIEW_DISTRIBUTION,
  previewInvalidationPath,
  previewPrefix,
  readManifest,
  storedKey,
} from './lib/build.mjs'
import { cacheControlFor, contentTypeFor, hashes, plainEtag, walkBuild } from './lib/files.mjs'
import { checkClaims, requestClaims } from './lib/oidc.mjs'
import { output, runIfMain, summary } from './lib/report.mjs'

const PARALLEL = 8

/**
 * Stores the build for `commit`, or reuses the complete one already there, then checks it against its manifest.
 * @returns {Promise<{ reused: boolean, manifestSha256: string, files: { path: string, size: number, sha256: string, etag: string }[] }>}
 */
export async function storeBuild({ store, site, repo, commit, buildDir, workflowSha, lockfileSha256, now = new Date(), log = console.log }) {
  const key = manifestKey(site, commit)
  let stored = await store.get(PREVIEW_BUCKET, key)
  const reused = Boolean(stored)

  if (stored) {
    log(`a complete build of ${commit} is already stored; reusing it (this run's build is not used)`)
  } else {
    const local = await walkBuild(buildDir)
    log(`storing ${local.length} files under ${buildPrefix(site, commit)}`)
    await pool(local, PARALLEL, async (f) => {
      const body = await readFile(path.join(buildDir, f.path))
      if (hashes(body).sha256 !== f.sha256) throw new Error(`${f.path} changed while deploying`)
      const result = await store.putIfAbsent(PREVIEW_BUCKET, storedKey(site, commit, f.path), body, {
        contentType: contentTypeFor(f.path),
        cacheControl: cacheControlFor(f.path),
        sha256: f.sha256,
      })
      if (result === 'exists') {
        // Left by an earlier run that stopped before its manifest. Fine if it's the same file; a different file means
        // the build isn't reproducible, and the write-once store can't take a second version of this commit.
        const head = await store.head(PREVIEW_BUCKET, storedKey(site, commit, f.path))
        if (head?.sha256 !== f.sha256) {
          throw new Error(`${f.path} is already stored for ${commit} with different content; this commit can't be stored again. Push a new commit to deploy`)
        }
      }
    })

    const manifest = makeManifest({ site, repo, commit, workflowSha, lockfileSha256, created: now.toISOString(), files: local })
    const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
    const result = await store.putIfAbsent(PREVIEW_BUCKET, key, body, {
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'no-store',
      sha256: hashes(body).sha256,
    })
    if (result === 'exists') log('another run stored the manifest first; using that one')
    stored = await store.get(PREVIEW_BUCKET, key)
    if (!stored) throw new Error(`stored ${key} but can't read it back`)
  }

  const manifestSha256 = hashes(stored.body).sha256
  const files = readManifest(JSON.parse(stored.body.toString('utf8')), { site, repo, commit })
  const checked = await pool(files, PARALLEL, async (f) => {
    const head = await store.head(PREVIEW_BUCKET, storedKey(site, commit, f.path))
    if (!head) throw new Error(`stored build is missing ${f.path}`)
    if (head.size !== f.size) throw new Error(`stored ${f.path} is ${head.size} bytes; the manifest says ${f.size}`)
    if (head.sha256 !== f.sha256) throw new Error(`stored ${f.path} doesn't match its manifest hash`)
    return { ...f, etag: plainEtag(head.etag) }
  })
  log(`stored build checked: ${checked.length} files match manifest ${manifestSha256}`)
  return { reused, manifestSha256, files: checked }
}

/**
 * Makes sites/<site>/ match the stored build.
 * @returns {Promise<{ copies: number, deletes: number, unchanged: number, invalidation: string | null }>}
 */
export async function publishPreview({ store, site, commit, files, maxShare = DEFAULT_MAX_DELETE_SHARE, log = console.log }) {
  const prefix = previewPrefix(site)
  const current = (await store.list(PREVIEW_BUCKET, prefix)).map((c) => ({ key: c.key, etag: plainEtag(c.etag) }))
  const plan = planSync(files, current)
  const refusal = deleteGuard({ current: current.length, deletes: plan.deletes.length, maxShare })
  if (refusal) throw new Error(refusal)

  // New files first and deletes last, so the preview never links to something already gone.
  await pool(plan.copies, PARALLEL, (file) => store.copy(PREVIEW_BUCKET, storedKey(site, commit, file), PREVIEW_BUCKET, `${prefix}${file}`))
  if (plan.deletes.length) await store.deleteMany(PREVIEW_BUCKET, plan.deletes.map((k) => `${prefix}${k}`))
  log(`preview: ${plan.copies.length} copied, ${plan.deletes.length} deleted, ${plan.unchanged} unchanged`)

  let invalidation = null
  if (plan.copies.length || plan.deletes.length) {
    invalidation = await store.invalidate(PREVIEW_DISTRIBUTION, [previewInvalidationPath(site)], `${site}-${commit}-${Date.now()}`)
    await store.waitInvalidation(PREVIEW_DISTRIBUTION, invalidation)
    log(`preview cache cleared (${invalidation})`)
  } else log('nothing changed; preview cache left alone')
  return { copies: plan.copies.length, deletes: plan.deletes.length, unchanged: plan.unchanged, invalidation }
}

async function main() {
  const env = process.env
  const site = checkSite(env.SITE)
  const commit = checkSha(env.COMMIT)
  const workflowSha = checkSha(env.WORKFLOW_SHA, 'workflow')
  const repo = env.REPO
  const maxShare = env.MAX_DELETE_SHARE ? Number(env.MAX_DELETE_SHARE) : DEFAULT_MAX_DELETE_SHARE
  if (!/^[0-9a-f]{64}$/.test(env.LOCKFILE_SHA256 ?? '')) throw new Error('LOCKFILE_SHA256 is not a SHA-256')

  const problems = checkClaims(await requestClaims(), { workflow: 'deploy-preview.yml', workflowSha, repo, commit })
  if (problems.length) throw new Error(`the OIDC token doesn't match this run: ${problems.join('; ')}`)

  const { awsStore } = await import('./lib/aws.mjs')
  const store = awsStore()
  const stored = await storeBuild({
    store,
    site,
    repo,
    commit,
    buildDir: env.BUILD_DIR,
    workflowSha,
    lockfileSha256: env.LOCKFILE_SHA256,
  })
  output('manifest-sha256', stored.manifestSha256)
  const how = stored.reused ? 'Reused' : 'Stored'
  summary(
    `### Stored build\n\n${how} \`${buildPrefix(site, commit)}\`: ${stored.files.length} files, ` +
      `manifest SHA-256 \`${stored.manifestSha256}\`.`,
  )

  if (env.PUBLISH !== 'true') {
    console.log(`::notice::${commit} is no longer main's head; stored its build but left the preview to the newer run`)
    summary('Preview not updated: a newer commit is on main and its own run publishes it.')
    return
  }
  const result = await publishPreview({ store, site, commit, files: stored.files, maxShare })
  const cache = result.invalidation ? `cache cleared (${result.invalidation})` : 'cache left alone'
  summary(
    `### Preview\n\nhttps://${site}.preview.coderize.dev: ${result.copies} copied, ${result.deletes} deleted, ` +
      `${result.unchanged} unchanged, ${cache}.`,
  )
}

runIfMain(import.meta.url, main)

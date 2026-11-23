// An in-memory stand-in for lib/aws.mjs, for the tests and dry runs. It behaves like S3 where the scripts depend on
// it: If-None-Match creates, MD5 ETags, SHA-256 checksums, copies that keep headers, and the bucket-policy rules the
// contract sets (_builds is write-once and undeletable; a live bucket takes only copies from its site's _builds).
//
// A government site's buckets (the stored builds, coderizehq-gov-builds-<account>, and each coderizehq-live-<site> made
// locked with `lock`) are Object-Locked with a default retention, as platform's aws/government makes them: an upload
// there without a checksum is refused, as S3 refuses one, and so is a copy that doesn't ask for one (what actions
// requires of itself there), and so is any delete (actions' release never deletes from a government site).

import { hashes, sha256HexToBase64 } from './files.mjs'
import { GOVERNMENT_BUILDS_BUCKET, PREVIEW_BUCKET } from './build.mjs'

const BUILD_BUCKETS = [PREVIEW_BUCKET, GOVERNMENT_BUILDS_BUCKET]

export function memoryStore() {
  const buckets = new Map()
  const calls = []
  const invalidations = []
  const locked = new Set([GOVERNMENT_BUILDS_BUCKET])
  const bucket = (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map())
    return buckets.get(name)
  }
  const denied = (msg) => Object.assign(new Error(msg), { name: 'AccessDenied' })
  const invalidRequest = (msg) => Object.assign(new Error(msg), { name: 'InvalidRequest' })

  return {
    calls,
    invalidations,
    buckets,
    locked,
    /** Marks a bucket Object-Locked with a default retention (a government site's live bucket). */
    lock(b) {
      locked.add(b)
    },
    /** Redirect stores by name, each a Map of "<apex><path>" -> target, as platform's redirect sync writes them. */
    redirectStores: new Map(),
    /** Puts an object directly, bypassing every rule (test setup only). */
    seed(b, key, body, extra = {}) {
      const buf = Buffer.from(body)
      const h = hashes(buf)
      bucket(b).set(key, { body: buf, etag: `"${h.md5}"`, sha256: h.sha256, ...extra })
    },
    async get(b, key) {
      calls.push(['get', b, key])
      const o = bucket(b).get(key)
      return o ? { body: o.body, etag: o.etag } : null
    },
    async head(b, key) {
      calls.push(['head', b, key])
      const o = bucket(b).get(key)
      return o ? { etag: o.etag, size: o.body.length, sha256: o.sha256 } : null
    },
    async putIfAbsent(b, key, body, { contentType, cacheControl, sha256 }) {
      calls.push(['put', b, key])
      if (!BUILD_BUCKETS.includes(b)) throw denied(`no direct writes to ${b}`)
      if (locked.has(b) && !/^[0-9a-f]{64}$/.test(sha256 ?? '')) throw invalidRequest(`${b} is Object-Locked: an upload needs a checksum`)
      if (hashes(body).sha256 !== sha256) throw new Error(`checksum mismatch for ${key} (${sha256HexToBase64(sha256)})`)
      if (bucket(b).has(key)) return 'exists'
      bucket(b).set(key, { body, etag: `"${hashes(body).md5}"`, sha256, contentType, cacheControl })
      return 'created'
    },
    async copy(srcBucket, srcKey, b, key, opts = {}) {
      calls.push(['copy', `${srcBucket}/${srcKey}`, b, key, opts])
      const src = bucket(srcBucket).get(srcKey)
      if (!src) throw Object.assign(new Error(`NoSuchKey ${srcKey}`), { name: 'NoSuchKey' })
      if (BUILD_BUCKETS.includes(b) && key.startsWith('_builds/')) throw denied('stored builds are write-once')
      if (locked.has(b) && !opts.checksum) throw invalidRequest(`${b} is Object-Locked: actions copies into it with a checksum`)
      if (b.startsWith('coderizehq-live-')) {
        // A live-account site's publish role reads the preview account's builds; a government site's, its own account's.
        const site = b.slice('coderizehq-live-'.length)
        const builds = locked.has(b) ? GOVERNMENT_BUILDS_BUCKET : PREVIEW_BUCKET
        if (srcBucket !== builds || !srcKey.startsWith(`_builds/${site}/`)) throw denied('live takes copies from its own _builds only')
      }
      bucket(b).set(key, { ...src })
      return { etag: src.etag }
    },
    async list(b, prefix) {
      calls.push(['list', b, prefix])
      return [...bucket(b).entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, o]) => ({ key: k.slice(prefix.length), size: o.body.length, etag: o.etag }))
    },
    async deleteMany(b, keys) {
      calls.push(['delete', b, keys.length])
      if (BUILD_BUCKETS.includes(b) && keys.some((k) => k.startsWith('_builds/'))) throw denied('stored builds are undeletable')
      if (locked.has(b)) throw denied(`${b} is a government site's: nothing is ever deleted there`)
      for (const k of keys) bucket(b).delete(k)
    },
    async redirects(name, site) {
      calls.push(['redirects', name, site])
      const out = new Map()
      for (const [key, value] of this.redirectStores.get(name) ?? []) {
        const slash = key.indexOf('/')
        if (key.startsWith('@') || slash <= 0) continue
        if (key.slice(0, slash).replaceAll('.', '-') === site) out.set(key.slice(slash), value)
      }
      return out
    },
    distributions: [],
    async findDistribution(comment) {
      calls.push(['findDistribution', comment])
      const found = this.distributions.filter((d) => d.comment === comment)
      if (found.length > 1) throw new Error(`${found.length} distributions have the comment ${comment}`)
      return found[0] ? { id: found[0].id, domainName: found[0].domainName, aliases: found[0].aliases } : null
    },
    async waitInvalidation(distributionId, id) {
      calls.push(['waitInvalidation', distributionId, id])
    },
    async invalidate(distributionId, paths) {
      calls.push(['invalidate', distributionId, paths.join(',')])
      invalidations.push({ distributionId, paths })
      return `I${invalidations.length}`
    },
  }
}

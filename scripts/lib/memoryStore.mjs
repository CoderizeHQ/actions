// An in-memory stand-in for lib/aws.mjs, for the tests and dry runs. It behaves like S3 where the scripts depend on
// it: If-None-Match creates, MD5 ETags, SHA-256 checksums, copies that keep headers, and the bucket-policy rules the
// contract sets (_builds is write-once and undeletable; a live bucket takes only copies from its site's _builds).

import { hashes, sha256HexToBase64 } from './files.mjs'
import { PREVIEW_BUCKET } from './build.mjs'

export function memoryStore() {
  const buckets = new Map()
  const calls = []
  const invalidations = []
  const bucket = (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map())
    return buckets.get(name)
  }
  const denied = (msg) => Object.assign(new Error(msg), { name: 'AccessDenied' })

  return {
    calls,
    invalidations,
    buckets,
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
      if (b !== PREVIEW_BUCKET) throw denied(`no direct writes to ${b}`)
      if (hashes(body).sha256 !== sha256) throw new Error(`checksum mismatch for ${key} (${sha256HexToBase64(sha256)})`)
      if (bucket(b).has(key)) return 'exists'
      bucket(b).set(key, { body, etag: `"${hashes(body).md5}"`, sha256, contentType, cacheControl })
      return 'created'
    },
    async copy(srcBucket, srcKey, b, key) {
      calls.push(['copy', `${srcBucket}/${srcKey}`, b, key])
      const src = bucket(srcBucket).get(srcKey)
      if (!src) throw Object.assign(new Error(`NoSuchKey ${srcKey}`), { name: 'NoSuchKey' })
      if (b === PREVIEW_BUCKET && key.startsWith('_builds/')) throw denied('stored builds are write-once')
      if (b.startsWith('coderizehq-live-')) {
        const site = b.slice('coderizehq-live-'.length)
        if (srcBucket !== PREVIEW_BUCKET || !srcKey.startsWith(`_builds/${site}/`)) throw denied('live takes copies from its own _builds only')
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
      if (b === PREVIEW_BUCKET && keys.some((k) => k.startsWith('_builds/'))) throw denied('stored builds are undeletable')
      for (const k of keys) bucket(b).delete(k)
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

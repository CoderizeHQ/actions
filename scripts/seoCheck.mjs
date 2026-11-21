// ci-site's post-build SEO check (plan, Phase 3 "Shared workflows", ci-site), on the built files, never the source,
// so it checks what will be served whatever produced it:
// - robots.txt exists, doesn't block every crawler, and names a sitemap that is in the build;
// - the site's host is the one robots.txt's sitemap is on (a PR can't see the site record: platform is private);
// - every URL in the sitemap is https on that host, has no trailing slash (the home page stays /), and has a built
//   page that isn't noindex;
// - every indexable page has exactly one canonical, absolute and https on that host, with no trailing slash, and not
//   the home page's unless it is the home page (error pages and noindex pages may have none, never two);
// - every page has a non-empty <title>, and no two pages share one;
// - no internal link has a trailing slash (`/about/`, `/about/#team`).
// Redirect pages (a meta refresh) are skipped. Pages are served the way live serves them: /page from page/index.html.
//
// Noindex mode (INDEXED=false), for a site whose platform record says `"indexed": false`: a sign-in app kept out of
// search on purpose. robots.txt must disallow every crawler from the whole site and name no sitemap, the build has no
// sitemap*.xml, and pages need no canonical (one that is there is still checked). Titles and links are checked as
// usual. Only platform asks for it: its app-checks.yml passes ci-site's `indexed` input from the record, through the
// app repo's SITE_PACKAGES variable, which a PR can't change. site-checks.yml (the `sites` ruleset) always runs indexed.

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { walkBuild } from './lib/files.mjs'
import { runIfMain, summary } from './lib/report.mjs'

const ERROR_PAGES = new Set(['/404.html', '/500.html'])

/** The URL path a built HTML file is served at (the same as axe and the live router). */
export function pagePath(file) {
  if (file === 'index.html') return '/'
  if (file.endsWith('/index.html')) return `/${file.slice(0, -'/index.html'.length)}`
  return `/${file}`
}

/** The built file a URL path answers with, or null. */
export function fileFor(pathname, files) {
  let p
  try {
    p = decodeURIComponent(pathname).replace(/^\/+/, '').replace(/\/+$/, '')
  } catch {
    return null
  }
  for (const candidate of p === '' ? ['index.html'] : [p, `${p}/index.html`]) if (files.has(candidate)) return candidate
  return null
}

export function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function attributes(tag) {
  const attrs = {}
  for (const m of tag.matchAll(/([^\s=/<>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/g)) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4])
  }
  return attrs
}

/**
 * The SEO-relevant parts of one page. Scripts, styles and comments go first, so a tag inside them isn't read.
 * @param {string} html
 */
export function parsePage(html) {
  const markup = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  const titles = [...markup.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi)].map((m) => decodeEntities(m[1]).replace(/\s+/g, ' ').trim())
  const canonicals = []
  for (const [tag] of markup.matchAll(/<link\b[^>]*>/gi)) {
    const a = attributes(tag)
    if ((a.rel ?? '').toLowerCase().split(/\s+/).includes('canonical')) canonicals.push(a.href ?? '')
  }
  let noindex = false
  let redirect = false
  for (const [tag] of markup.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributes(tag)
    if (/^(robots|googlebot)$/i.test(a.name ?? '') && /(^|[\s,])(noindex|none)($|[\s,])/i.test(a.content ?? '')) noindex = true
    if ((a['http-equiv'] ?? '').toLowerCase() === 'refresh' && /url\s*=/i.test(a.content ?? '')) redirect = true
  }
  const links = [...markup.matchAll(/<a\b[^>]*>/gi)].map(([tag]) => attributes(tag).href).filter((h) => h !== undefined)
  return { title: titles[0] ?? '', canonicals, noindex, redirect, links }
}

/** robots.txt's sitemaps, and whether its `User-agent: *` group disallows everything. */
export function parseRobots(text) {
  const sitemaps = []
  let blocksAll = false
  let agents = []
  let inRules = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line)
    if (!m) continue
    const field = m[1].toLowerCase()
    const value = m[2].trim()
    if (field === 'sitemap') sitemaps.push(value)
    else if (field === 'user-agent') {
      if (inRules) agents = []
      inRules = false
      agents.push(value)
    } else if (field === 'disallow' || field === 'allow') {
      inRules = true
      if (field === 'disallow' && value === '/' && agents.includes('*')) blocksAll = true
    }
  }
  return { sitemaps, blocksAll }
}

/** The <loc>s of a sitemap, and whether it's a sitemap index. */
export function parseSitemap(xml) {
  return {
    index: /<sitemapindex\b/i.test(xml),
    locs: [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1])),
  }
}

const hasTrailingSlash = (pathname) => pathname.length > 1 && pathname.endsWith('/')

function absolute(href) {
  try {
    return new URL(href)
  } catch {
    return null
  }
}

/**
 * Every problem in a build.
 * @param {{ files: Set<string>, read: (file: string) => string, siteUrl?: string, indexed?: boolean }} build
 *   indexed: false for a site whose platform record says `"indexed": false` (noindex mode, at the top)
 * @returns {{ origin: string | null, pages: number, sitemapUrls: number, problems: string[] }}
 */
export function checkBuild({ files, read, siteUrl, indexed = true }) {
  const problems = []

  // robots.txt and the site's host.
  let origin = null
  const sitemapFiles = []
  if (!files.has('robots.txt')) problems.push('robots.txt is missing')
  else {
    const robots = parseRobots(read('robots.txt'))
    if (!indexed) {
      // Noindex mode: shut every crawler out, and no sitemap anywhere.
      if (!robots.blocksAll) problems.push('robots.txt must disallow every crawler: the site record says indexed: false')
      if (robots.sitemaps.length) problems.push('robots.txt names a sitemap, but the site record says indexed: false (a noindex site has no sitemap)')
    } else {
      if (robots.blocksAll) problems.push('robots.txt disallows / for every crawler (a preview robots.txt must not ship)')
      if (!robots.sitemaps.length) problems.push('robots.txt names no sitemap (add `Sitemap: https://<domain>/sitemap.xml`)')
    }
    for (const s of indexed ? robots.sitemaps : []) {
      const u = absolute(s)
      if (!u || u.protocol !== 'https:') {
        problems.push(`robots.txt names the sitemap ${s}, which is not an absolute https URL`)
        continue
      }
      origin ??= u.origin
      if (u.origin !== origin) problems.push(`robots.txt names sitemaps on two hosts: ${origin} and ${u.origin}`)
      const file = fileFor(u.pathname, files)
      if (!file) problems.push(`robots.txt names ${s}, which is not in the build`)
      else sitemapFiles.push(file)
    }
  }
  if (siteUrl) {
    const want = absolute(siteUrl)?.origin
    if (origin && want && origin !== want) problems.push(`robots.txt's sitemap is on ${origin}, not the site's ${want}`)
    origin = want ?? origin
  }
  if (!indexed) {
    for (const f of [...files].filter((x) => /(^|\/)sitemap[^/]*\.xml$/.test(x)).sort()) {
      problems.push(`${f} is in the build, but the site record says indexed: false (a noindex site has no sitemap)`)
    }
  }

  // Pages.
  const pages = new Map()
  for (const file of [...files].filter((f) => f.endsWith('.html')).sort()) {
    const page = parsePage(read(file))
    if (!page.redirect) pages.set(pagePath(file), { file, ...page })
  }
  const titles = new Map()
  for (const [p, page] of pages) {
    if (!page.title) problems.push(`${p} has no <title>`)
    else titles.set(page.title, [...(titles.get(page.title) ?? []), p])

    if (page.canonicals.length > 1) problems.push(`${p} has ${page.canonicals.length} canonicals; a page has one`)
    if (indexed && page.canonicals.length === 0 && !page.noindex && !ERROR_PAGES.has(p)) problems.push(`${p} has no canonical`)
    for (const href of page.canonicals) {
      const u = absolute(href)
      if (!u || u.protocol !== 'https:') problems.push(`${p}: the canonical ${href} is not an absolute https URL`)
      else {
        if (origin && u.origin !== origin) problems.push(`${p}: the canonical ${href} is not on ${origin}`)
        if (hasTrailingSlash(u.pathname)) problems.push(`${p}: the canonical ${href} has a trailing slash`)
        if (u.pathname === '/' && p !== '/' && !ERROR_PAGES.has(p)) problems.push(`${p}: the canonical points at the home page`)
      }
    }

    for (const href of page.links) {
      if (/^(#|mailto:|tel:|javascript:|data:|sms:)/i.test(href.trim())) continue
      let u
      try {
        u = new URL(href.trim(), `${origin ?? 'https://site.invalid'}${p}`)
      } catch {
        problems.push(`${p}: the link ${href} is not a valid URL`)
        continue
      }
      const internal = /^\/(?!\/)/.test(href.trim()) || !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href.trim()) || u.origin === origin
      if (internal && hasTrailingSlash(u.pathname)) problems.push(`${p}: the link ${href} has a trailing slash`)
    }
  }
  for (const [title, at] of titles) if (at.length > 1) problems.push(`${at.sort().join(', ')} share the title "${title}"`)

  // The sitemap: every URL built, indexable, on the host, without a trailing slash.
  let sitemapUrls = 0
  const seen = new Set()
  const queue = [...sitemapFiles]
  for (let file = queue.shift(); file; file = queue.shift()) {
    if (seen.has(file)) continue
    seen.add(file)
    const map = parseSitemap(read(file))
    for (const loc of map.locs) {
      const u = absolute(loc)
      if (!u || u.protocol !== 'https:') {
        problems.push(`${file}: ${loc} is not an absolute https URL`)
        continue
      }
      if (origin && u.origin !== origin) problems.push(`${file}: ${loc} is not on ${origin}`)
      const target = fileFor(u.pathname, files)
      if (map.index) {
        if (!target) problems.push(`${file} lists the sitemap ${loc}, which is not in the build`)
        else queue.push(target)
        continue
      }
      sitemapUrls++
      if (hasTrailingSlash(u.pathname)) problems.push(`${file}: ${loc} has a trailing slash`)
      if (!target || !target.endsWith('.html')) problems.push(`${file} lists ${loc}, but no page was built for it`)
      else if (pages.get(pagePath(target))?.noindex) problems.push(`${file} lists ${loc}, which is noindex`)
    }
  }
  if (sitemapFiles.length && sitemapUrls === 0) problems.push('the sitemap lists no pages')

  return { origin, pages: pages.size, sitemapUrls, problems }
}

async function main() {
  const root = path.resolve(process.env.BUILD_DIR ?? 'dist')
  const list = (await walkBuild(root)).map((f) => f.path)
  const text = new Map()
  for (const f of list.filter((x) => /\.(html|xml|txt)$/.test(x))) text.set(f, await readFile(path.join(root, f), 'utf8'))
  const indexed = process.env.INDEXED !== 'false'
  const result = checkBuild({ files: new Set(list), read: (f) => text.get(f) ?? '', siteUrl: process.env.SITE_URL || undefined, indexed })
  const head = indexed
    ? `${result.pages} pages and ${result.sitemapUrls} sitemap URLs on ${result.origin ?? 'an unknown host'}`
    : `${result.pages} pages in noindex mode (the site record says indexed: false) on ${result.origin ?? 'an unknown host'}`
  if (result.problems.length) {
    for (const p of result.problems.slice(0, 50)) console.log(`::error::${p}`)
    if (result.problems.length > 50) console.log(`::error::and ${result.problems.length - 50} more (see the job summary)`)
    summary(`### SEO check\n\n${head}: ${result.problems.length} problems.\n\n${result.problems.map((p) => `- ${p}`).join('\n')}`)
    process.exit(1)
  }
  summary(`### SEO check\n\n${head}: no problems.`)
  console.log(`${head}: no problems.`)
}

runIfMain(import.meta.url, main)

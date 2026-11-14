// axe's scan (plan, Phase 3 "Shared workflows"): every built page, in light and dark color schemes, after the
// network is idle, against WCAG 2.2 AA including target size. It fails on any violation, on a page that doesn't
// answer 200, and on fewer pages than expected: fewer than min-pages, or a sitemap URL with no built page.
//
// The build is served the way live serves it (/page from /page/index.html; a missing page answers /404.html with
// 404), from a local server, so nothing leaves the runner.

import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'

import { contentTypeFor, walkBuild } from './lib/files.mjs'
import { runIfMain, summary } from './lib/report.mjs'

export const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa']
export const SCHEMES = ['light', 'dark']

/** The URL path each built page is served at. */
export function pagePaths(files) {
  return files
    .filter((f) => f.endsWith('.html'))
    .map((f) => (f === 'index.html' ? '/' : f.endsWith('/index.html') ? `/${f.slice(0, -'/index.html'.length)}` : `/${f}`))
    .sort()
}

/**
 * Which file answers a request path, and with what status, the way the live router and the 404 handler answer it.
 * @param {string} pathname @param {Set<string>} files
 * @returns {{ file: string | null, status: number }}
 */
export function resolve(pathname, files) {
  let p
  try {
    p = decodeURIComponent(pathname).replace(/^\/+/, '').replace(/\/+$/, '')
  } catch {
    return { file: files.has('404.html') ? '404.html' : null, status: 404 }
  }
  if (p.split('/').includes('..')) return { file: null, status: 400 }
  for (const candidate of p === '' ? ['index.html'] : [p, `${p}/index.html`]) {
    if (files.has(candidate)) return { file: candidate, status: 200 }
  }
  return { file: files.has('404.html') ? '404.html' : null, status: 404 }
}

/** Page paths a sitemap lists (sitemap-index entries pointing at other sitemaps are skipped). */
export function sitemapPaths(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)]
    .map((m) => m[1])
    .filter((loc) => !loc.endsWith('.xml'))
    .map((loc) => {
      const p = new URL(loc).pathname
      return p.length > 1 ? p.replace(/\/+$/, '') : '/'
    })
}

/** The problems that fail the job, from the scan's results. */
export function judge({ pages, results, expected, minPages }) {
  const problems = []
  if (pages.length < minPages) problems.push(`found ${pages.length} pages; expected at least ${minPages}`)
  const scanned = new Set(pages)
  for (const p of expected) if (!scanned.has(p)) problems.push(`the sitemap lists ${p}, but no page was built for it`)
  for (const r of results) {
    if (r.status !== 200) problems.push(`${r.page} answered ${r.status}`)
    for (const v of r.violations) {
      const where = v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')
      problems.push(`${r.page} (${r.scheme}): ${v.id} [${v.impact}] ${v.help} — ${where}${v.nodes.length > 3 ? ` and ${v.nodes.length - 3} more` : ''}`)
    }
  }
  return problems
}

export function serve(root, files) {
  const server = createServer((req, res) => {
    const { file, status } = resolve(new URL(req.url, 'http://x').pathname, files)
    if (!file) {
      res.writeHead(status, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    res.writeHead(status, { 'content-type': contentTypeFor(file) })
    createReadStream(path.join(root, file)).pipe(res)
  })
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)))
}

async function main() {
  const root = path.resolve(process.env.BUILD_DIR ?? 'dist')
  const minPages = Number(process.env.MIN_PAGES ?? 1)
  const files = (await walkBuild(root)).map((f) => f.path)
  const pages = pagePaths(files)
  const expected = new Set()
  for (const f of files.filter((x) => /(^|\/)sitemap[^/]*\.xml$/.test(x))) {
    for (const p of sitemapPaths(await readFile(path.join(root, f), 'utf8'))) expected.add(p)
  }

  const { chromium } = await import('playwright')
  const { default: AxeBuilder } = await import('@axe-core/playwright')
  const server = await serve(root, new Set(files))
  const base = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch()
  const results = []
  try {
    for (const scheme of SCHEMES) {
      const context = await browser.newContext({ colorScheme: scheme })
      const page = await context.newPage()
      for (const p of pages) {
        const response = await page.goto(`${base}${p}`, { waitUntil: 'networkidle' })
        const { violations } = await new AxeBuilder({ page })
          .options({ runOnly: { type: 'tag', values: TAGS }, rules: { 'target-size': { enabled: true } } })
          .analyze()
        results.push({ page: p, scheme, status: response?.status() ?? 0, violations })
        console.log(`${p} (${scheme}): ${response?.status()}, ${violations.length} violations`)
      }
      await context.close()
    }
  } finally {
    await browser.close()
    server.close()
  }

  const problems = judge({ pages, results, expected: [...expected], minPages })
  const verdict = problems.length ? `${problems.length} problems` : 'no violations'
  summary(`### axe\n\n${pages.length} pages × ${SCHEMES.length} color schemes, WCAG 2.2 AA with target size: ${verdict}.`)
  if (problems.length) {
    for (const p of problems) console.log(`::error::${p}`)
    summary(problems.map((p) => `- ${p}`).join('\n'))
    process.exit(1)
  }
}

runIfMain(import.meta.url, main)

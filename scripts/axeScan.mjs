// axe's scan (plan, Phase 3 "Shared workflows"): the built pages, in light and dark color schemes, after the
// network is idle, against WCAG 2.2 AA including target size. It fails on any violation, on a page that doesn't
// answer 200, and on fewer pages than expected: fewer than min-pages, or a sitemap URL with no built page.
//
// Pages built from one template (a page per event, a page per chapter) give the same violations, so a big family of
// them is sampled: PAGES_PER_TEMPLATE pages each (3 by default; 0 scans every page), picked the same way on every run
// (templateKeys and samplePages below). Every other page is scanned. min-pages and the sitemap check count every built
// page, not the sample: they read files, not the browser.
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
export const DEFAULT_PAGES_PER_TEMPLATE = 3
// More different values than this at one place in the path make it a slug (templateKeys).
export const SLUG_VALUES = 10

/** The URL path each built page is served at. */
export function pagePaths(files) {
  return files
    .filter((f) => f.endsWith('.html'))
    .map((f) => (f === 'index.html' ? '/' : f.endsWith('/index.html') ? `/${f.slice(0, -'/index.html'.length)}` : `/${f}`))
    .sort()
}

/**
 * Each page's template, guessed from the shape of the paths: a path segment after the first is a slug, `*`, when more
 * than SLUG_VALUES (or pages-per-template, if that is higher) different values sit at that place under the same parent.
 * So 300 `/events/<slug>` pages are `/events/*`, and with enough chapters `/chapters/<c>/events/<slug>` is one family
 * across every chapter (a `*` for the chapter and one for the slug), and `/chapters/<c>/contact` is another. A
 * top-level page (`/about`) is never a slug, and neither is a handful of hand-made siblings (`/legal/privacy`,
 * `/legal/terms`): each keeps its own key and is scanned. `perTemplate` 0 gives every page its own key.
 * @param {string[]} pages @param {number} perTemplate
 * @returns {Map<string, string>} page path to template key
 */
export function templateKeys(pages, perTemplate) {
  const split = pages.map((p) => ({ page: p, segments: p === '/' ? [] : p.slice(1).split('/') }))
  const keys = new Map(split.map(({ page, segments }) => [page, segments.slice(0, 1)]))
  const depth = Math.max(0, ...split.map((s) => s.segments.length))
  const most = Math.max(SLUG_VALUES, perTemplate)
  for (let i = 1; i < depth && perTemplate > 0; i++) {
    const children = new Map()
    for (const { page, segments } of split) {
      if (segments.length <= i) continue
      const parent = keys.get(page).join('/')
      if (!children.has(parent)) children.set(parent, new Set())
      children.get(parent).add(segments[i])
    }
    for (const { page, segments } of split) {
      if (segments.length <= i) continue
      const key = keys.get(page)
      key.push(children.get(key.join('/')).size > most ? '*' : segments[i])
    }
  }
  return new Map([...keys].map(([page, key]) => [page, `/${key.join('/')}`]))
}

/**
 * The pages to scan: every page whose template key is its own path, and from each family of more than `perTemplate`
 * pages, `perTemplate` of them, sorted and evenly spread from the first to the last, so a rerun scans the same pages.
 * @param {string[]} pages @param {number} perTemplate 0 scans every page
 * @returns {{ scan: string[], families: { key: string, built: number, scanned: string[] }[] }}
 */
export function samplePages(pages, perTemplate) {
  if (!Number.isInteger(perTemplate) || perTemplate < 0) {
    throw new Error(`pages-per-template must be a whole number, 0 or more; got ${perTemplate}`)
  }
  const families = new Map()
  for (const [page, key] of templateKeys(pages, perTemplate)) {
    if (!families.has(key)) families.set(key, [])
    families.get(key).push(page)
  }
  const scan = []
  const sampled = []
  for (const [key, members] of [...families].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    members.sort()
    if (perTemplate === 0 || members.length <= perTemplate) {
      scan.push(...members)
      continue
    }
    // The first, the last and the rest evenly between (only the first when perTemplate is 1). With more members than
    // picks, the step is over 1, so no page is picked twice.
    const step = perTemplate === 1 ? 0 : (members.length - 1) / (perTemplate - 1)
    const picks = Array.from({ length: perTemplate }, (_, i) => members[Math.round(i * step)])
    scan.push(...picks)
    sampled.push({ key, built: members.length, scanned: picks })
  }
  return { scan: scan.sort(), families: sampled }
}

/** How many pages the build has and how many the scan loads, so a sample never reads as missing pages. */
export function scanLine({ built, scanned, perTemplate }) {
  const how = perTemplate === 0 ? 'every page (pages-per-template: 0)' : `up to ${perTemplate} per template (pages-per-template: ${perTemplate})`
  return `${built} pages built, ${scanned} scanned: ${how}`
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
  const perTemplate = Number(process.env.PAGES_PER_TEMPLATE || DEFAULT_PAGES_PER_TEMPLATE)
  const files = (await walkBuild(root)).map((f) => f.path)
  const pages = pagePaths(files)
  const expected = new Set()
  for (const f of files.filter((x) => /(^|\/)sitemap[^/]*\.xml$/.test(x))) {
    for (const p of sitemapPaths(await readFile(path.join(root, f), 'utf8'))) expected.add(p)
  }
  const { scan, families } = samplePages(pages, perTemplate)
  const line = scanLine({ built: pages.length, scanned: scan.length, perTemplate })
  console.log(line)
  for (const f of families) console.log(`${f.key}: ${f.scanned.length} of ${f.built} pages (${f.scanned.join(', ')})`)

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
      for (const p of scan) {
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
  summary(`### axe\n\n${line}; ${SCHEMES.length} color schemes, WCAG 2.2 AA with target size: ${verdict}.`)
  if (families.length) {
    const rows = families.map((f) => `| \`${f.key}\` | ${f.scanned.length} | ${f.built} |`)
    summary(['', '| Template | Scanned | Built |', '| --- | --- | --- |', ...rows, ''].join('\n'))
  }
  if (problems.length) {
    for (const p of problems) console.log(`::error::${p}`)
    summary(problems.map((p) => `- ${p}`).join('\n'))
    process.exit(1)
  }
}

runIfMain(import.meta.url, main)

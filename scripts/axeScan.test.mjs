import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { judge, pagePaths, resolve, samplePages, scanLine, serve, sitemapPaths, SLUG_VALUES, templateKeys } from './axeScan.mjs'

const files = new Set(['index.html', 'about/index.html', '404.html', 'robots.txt', '_astro/a.DQ3k2zL8.css'])

test('pages are served at their clean paths', () => {
  assert.deepEqual(pagePaths([...files]), ['/', '/404.html', '/about'])
})

test('requests resolve the way live answers them', () => {
  assert.deepEqual(resolve('/', files), { file: 'index.html', status: 200 })
  assert.deepEqual(resolve('/about', files), { file: 'about/index.html', status: 200 })
  assert.deepEqual(resolve('/about/', files), { file: 'about/index.html', status: 200 })
  assert.deepEqual(resolve('/robots.txt', files), { file: 'robots.txt', status: 200 })
  assert.deepEqual(resolve('/nope', files), { file: '404.html', status: 404 })
  assert.deepEqual(resolve('/%E0%A4%A', files), { file: '404.html', status: 404 })
  assert.equal(resolve('/../secret', files).status, 400)
})

test('sitemap URLs become page paths; nested sitemaps are skipped', () => {
  const xml = '<urlset><url><loc>https://x.com/</loc></url><url><loc>https://x.com/about</loc></url><url><loc> https://x.com/a/b/ </loc></url></urlset>'
  assert.deepEqual(sitemapPaths(xml), ['/', '/about', '/a/b'])
  assert.deepEqual(sitemapPaths('<sitemapindex><sitemap><loc>https://x.com/sitemap-0.xml</loc></sitemap></sitemapindex>'), [])
})

// A site shaped like gronetworking.com: one-off pages, two hand-made legal pages, an event page per event, a page per
// chapter, and each chapter's own contact page and events.
const n = (count, make) => Array.from({ length: count }, (_, i) => make(String(i).padStart(3, '0')))
const chapters = n(SLUG_VALUES + 2, (i) => `c${i}`)
const site = [
  '/',
  '/404.html',
  '/about',
  '/contact',
  '/events',
  '/legal/privacy',
  '/legal/terms',
  ...n(300, (i) => `/events/e${i}`),
  '/chapters',
  ...chapters.map((c) => `/chapters/${c}`),
  ...chapters.map((c) => `/chapters/${c}/contact`),
  ...chapters.flatMap((c) => n(4, (i) => `/chapters/${c}/events/${c}-x${i}`)),
]

test('pages are grouped by template from the shape of their paths', () => {
  const keys = templateKeys(site, 3)
  assert.equal(keys.get('/events/e042'), '/events/*')
  assert.equal(keys.get('/chapters/c003'), '/chapters/*')
  assert.equal(keys.get('/chapters/c003/events/c003-x001'), '/chapters/*/events/*')
  // The same page under every chapter is a family of its own.
  assert.equal(keys.get('/chapters/c003/contact'), '/chapters/*/contact')
  for (const p of ['/', '/404.html', '/about', '/events', '/chapters', '/legal/privacy', '/legal/terms']) assert.equal(keys.get(p), p)
  // A few siblings, or a wide parent no deeper than the top level, are separate pages, never a family.
  assert.equal(templateKeys(n(SLUG_VALUES, (i) => `/services/s${i}`), 3).get('/services/s001'), '/services/s001')
  assert.equal(templateKeys(n(50, (i) => `/page${i}`), 3).get('/page001'), '/page001')
  // pages-per-template above the slug threshold raises it: a family is always bigger than its sample.
  assert.equal(templateKeys(n(SLUG_VALUES + 5, (i) => `/blog/p${i}`), 3).get('/blog/p001'), '/blog/*')
  assert.equal(templateKeys(n(SLUG_VALUES + 5, (i) => `/blog/p${i}`), SLUG_VALUES + 5).get('/blog/p001'), '/blog/p001')
})

test('each family is sampled, first, last and spread between; every one-off page is scanned', () => {
  const { scan, families } = samplePages(site, 3)
  assert.deepEqual(
    families.map((f) => [f.key, f.built, f.scanned]),
    [
      ['/chapters/*', 12, ['/chapters/c000', '/chapters/c006', '/chapters/c011']],
      ['/chapters/*/contact', 12, ['/chapters/c000/contact', '/chapters/c006/contact', '/chapters/c011/contact']],
      ['/chapters/*/events/*', 48, ['/chapters/c000/events/c000-x000', '/chapters/c006/events/c006-x000', '/chapters/c011/events/c011-x003']],
      ['/events/*', 300, ['/events/e000', '/events/e150', '/events/e299']],
    ],
  )
  for (const p of ['/', '/404.html', '/about', '/contact', '/events', '/legal/privacy', '/legal/terms', '/chapters']) assert.ok(scan.includes(p), p)
  assert.equal(scan.length, 8 + 12)
  assert.deepEqual(scan, [...scan].sort())
  assert.deepEqual(samplePages(site, 1).families.map((f) => f.scanned), [['/chapters/c000'], ['/chapters/c000/contact'], ['/chapters/c000/events/c000-x000'], ['/events/e000']])
})

test('the sample is the same on every run, whatever order the pages come in', () => {
  const shuffled = [...site].reverse()
  shuffled.push(shuffled.shift())
  assert.deepEqual(samplePages(shuffled, 3), samplePages(site, 3))
  assert.deepEqual(samplePages(site, 5).scan, samplePages(site, 5).scan)
})

test('pages-per-template 0 scans every page; anything but a whole number is refused', () => {
  const { scan, families } = samplePages(site, 0)
  assert.deepEqual(scan, [...site].sort())
  assert.deepEqual(families, [])
  for (const bad of [-1, 1.5, Number.NaN]) assert.throws(() => samplePages(site, bad), /pages-per-template must be a whole number/)
})

test('the summary says how many pages were built and scanned, and how', () => {
  assert.equal(scanLine({ built: 328, scanned: 27, perTemplate: 3 }), '328 pages built, 27 scanned: up to 3 per template (pages-per-template: 3)')
  assert.equal(scanLine({ built: 328, scanned: 328, perTemplate: 0 }), '328 pages built, 328 scanned: every page (pages-per-template: 0)')
})

test('any violation, a page that does not answer 200, or too few pages fails', () => {
  const ok = { page: '/', scheme: 'light', status: 200, violations: [] }
  assert.deepEqual(judge({ pages: ['/'], results: [ok], expected: ['/'], minPages: 1 }), [])
  const violation = { id: 'target-size', impact: 'serious', help: 'Touch targets must be big enough', nodes: [{ target: ['a.tiny'] }] }
  assert.match(judge({ pages: ['/'], results: [{ ...ok, scheme: 'dark', violations: [violation] }], expected: [], minPages: 1 })[0], /\(dark\): target-size/)
  assert.match(judge({ pages: ['/'], results: [{ ...ok, status: 404 }], expected: [], minPages: 1 })[0], /answered 404/)
  assert.match(judge({ pages: ['/'], results: [ok], expected: [], minPages: 5 })[0], /expected at least 5/)
  assert.match(judge({ pages: ['/'], results: [ok], expected: ['/', '/contact'], minPages: 1 })[0], /\/contact/)
})

test('min-pages and the sitemap check count every built page, not only the sample', () => {
  const results = samplePages(site, 3).scan.map((page) => ({ page, scheme: 'light', status: 200, violations: [] }))
  assert.deepEqual(judge({ pages: site, results, expected: ['/events/e042', '/chapters/c003/events/c003-x002'], minPages: site.length }), [])
  assert.match(judge({ pages: site, results, expected: ['/events/e300'], minPages: 1 })[0], /lists \/events\/e300, but no page was built/)
})

test('the local server answers like live, with the 404 page on a 404', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'axe-'))
  await mkdir(path.join(dir, 'about'))
  await writeFile(path.join(dir, 'index.html'), 'home')
  await writeFile(path.join(dir, 'about', 'index.html'), 'about')
  await writeFile(path.join(dir, '404.html'), 'missing')
  const server = await serve(dir, new Set(['index.html', 'about/index.html', '404.html']))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const about = await fetch(`${base}/about`)
    assert.equal(about.status, 200)
    assert.equal(about.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(await about.text(), 'about')
    const missing = await fetch(`${base}/nope`)
    assert.equal(missing.status, 404)
    assert.equal(await missing.text(), 'missing')
  } finally {
    server.close()
  }
})

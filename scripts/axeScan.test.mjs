import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { judge, pagePaths, resolve, serve, sitemapPaths } from './axeScan.mjs'

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

test('any violation, a page that does not answer 200, or too few pages fails', () => {
  const ok = { page: '/', scheme: 'light', status: 200, violations: [] }
  assert.deepEqual(judge({ pages: ['/'], results: [ok], expected: ['/'], minPages: 1 }), [])
  const violation = { id: 'target-size', impact: 'serious', help: 'Touch targets must be big enough', nodes: [{ target: ['a.tiny'] }] }
  assert.match(judge({ pages: ['/'], results: [{ ...ok, scheme: 'dark', violations: [violation] }], expected: [], minPages: 1 })[0], /\(dark\): target-size/)
  assert.match(judge({ pages: ['/'], results: [{ ...ok, status: 404 }], expected: [], minPages: 1 })[0], /answered 404/)
  assert.match(judge({ pages: ['/'], results: [ok], expected: [], minPages: 5 })[0], /expected at least 5/)
  assert.match(judge({ pages: ['/'], results: [ok], expected: ['/', '/contact'], minPages: 1 })[0], /\/contact/)
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

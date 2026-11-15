import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkBuild, parsePage, parseRobots, parseSitemap } from './seoCheck.mjs'

const page = ({ title = 'Home', canonical = 'https://x.com/', links = [], extra = '' } = {}) =>
  `<!doctype html><html><head><title>${title}</title>${canonical === null ? '' : `<link rel="canonical" href="${canonical}">`}${extra}</head>` +
  `<body>${links.map((l) => `<a href="${l}">x</a>`).join('')}</body></html>`

// A build that passes; each test breaks one thing.
function site(overrides = {}) {
  const files = {
    'index.html': page({ links: ['/', '/about', '/about#team', 'https://other.com/a/', 'mailto:a@x.com', '#top'] }),
    'about/index.html': page({ title: 'About', canonical: 'https://x.com/about' }),
    'private/index.html': page({ title: 'Private', canonical: null, extra: '<meta name="robots" content="noindex">' }),
    'old/index.html': '<meta http-equiv="refresh" content="0; url=/about">',
    '404.html': page({ title: 'Not found', canonical: null }),
    'robots.txt': 'User-agent: *\nAllow: /\n\nSitemap: https://x.com/sitemap-index.xml\n',
    'sitemap-index.xml': '<sitemapindex><sitemap><loc>https://x.com/sitemap-0.xml</loc></sitemap></sitemapindex>',
    'sitemap-0.xml': '<urlset><url><loc>https://x.com/</loc></url><url><loc>https://x.com/about</loc></url></urlset>',
    ...overrides,
  }
  for (const [k, v] of Object.entries(files)) if (v === undefined) delete files[k]
  return checkBuild({ files: new Set(Object.keys(files)), read: (f) => files[f] ?? '' })
}

test('a clean build passes, its host taken from robots.txt', () => {
  const r = site()
  assert.deepEqual(r.problems, [])
  assert.equal(r.origin, 'https://x.com')
  assert.equal(r.pages, 4) // the redirect page is skipped
  assert.equal(r.sitemapUrls, 2)
})

test('robots.txt must exist, allow crawlers and name a sitemap in the build', () => {
  assert.match(site({ 'robots.txt': undefined }).problems.join('\n'), /robots\.txt is missing/)
  assert.match(site({ 'robots.txt': 'User-agent: *\nDisallow: /\nSitemap: https://x.com/sitemap-index.xml' }).problems.join('\n'), /disallows \//)
  assert.match(site({ 'robots.txt': 'User-agent: *\nAllow: /' }).problems.join('\n'), /names no sitemap/)
  assert.match(site({ 'robots.txt': 'Sitemap: https://x.com/missing.xml' }).problems.join('\n'), /not in the build/)
  assert.match(site({ 'robots.txt': 'Sitemap: /sitemap-index.xml' }).problems.join('\n'), /not an absolute https URL/)
  assert.deepEqual(parseRobots('User-agent: googlebot\nDisallow: /\n\nUser-agent: *\nAllow: /').blocksAll, false)
})

test('canonicals: one per indexable page, absolute https on the host, no trailing slash, not home elsewhere', () => {
  const problems = (o) => site(o).problems.join('\n')
  assert.match(problems({ 'about/index.html': page({ title: 'About', canonical: null }) }), /\/about has no canonical/)
  assert.match(problems({ 'about/index.html': page({ title: 'About', canonical: '/about' }) }), /not an absolute https URL/)
  assert.match(problems({ 'about/index.html': page({ title: 'About', canonical: 'https://www.x.com/about' }) }), /not on https:\/\/x\.com/)
  assert.match(problems({ 'about/index.html': page({ title: 'About', canonical: 'https://x.com/about/' }) }), /trailing slash/)
  assert.match(problems({ 'about/index.html': page({ title: 'About', canonical: 'https://x.com/' }) }), /points at the home page/)
  assert.match(problems({ 'about/index.html': page({ title: 'About', canonical: 'https://x.com/about', extra: '<link rel="canonical" href="https://x.com/b">' }) }), /2 canonicals/)
})

test('titles: every page has one, and no two pages share one', () => {
  assert.match(site({ 'about/index.html': page({ title: ' ', canonical: 'https://x.com/about' }) }).problems.join('\n'), /\/about has no <title>/)
  assert.match(site({ 'about/index.html': page({ title: 'Home', canonical: 'https://x.com/about' }) }).problems.join('\n'), /\/, \/about share the title "Home"/)
})

test('no internal link has a trailing slash', () => {
  const problems = site({ 'index.html': page({ links: ['/about/', 'https://x.com/about/#team', 'about/', '//x.com/about/', '/'] }) }).problems
  assert.equal(problems.length, 4)
  assert.ok(problems.every((p) => /trailing slash/.test(p)))
})

test('sitemap URLs are on the host, without a trailing slash, built, and indexable', () => {
  const urlset = (...locs) => `<urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`
  const problems = (...locs) => site({ 'sitemap-0.xml': urlset(...locs) }).problems.join('\n')
  assert.match(problems('https://x.com/about/'), /has a trailing slash/)
  assert.match(problems('https://other.com/about'), /not on https:\/\/x\.com/)
  assert.match(problems('https://x.com/contact'), /no page was built for it/)
  assert.match(problems('https://x.com/private'), /noindex/)
  assert.match(problems(), /lists no pages/)
  assert.match(site({ 'sitemap-index.xml': '<sitemapindex><sitemap><loc>https://x.com/sitemap-9.xml</loc></sitemap></sitemapindex>' }).problems.join('\n'), /sitemap-9\.xml, which is not in the build/)
  assert.deepEqual(parseSitemap('<urlset><url><loc> https://x.com/a?b=1&amp;c=2 </loc></url></urlset>').locs, ['https://x.com/a?b=1&c=2'])
})

test('SITE_URL, when set, must be the host robots.txt names', () => {
  const files = { 'index.html': page(), 'robots.txt': 'Sitemap: https://x.com/s.xml', 's.xml': '<urlset><url><loc>https://x.com/</loc></url></urlset>' }
  const r = checkBuild({ files: new Set(Object.keys(files)), read: (f) => files[f], siteUrl: 'https://y.com' })
  assert.match(r.problems.join('\n'), /not the site's https:\/\/y\.com/)
})

test('tags inside scripts, styles and comments are not read', () => {
  const p = parsePage('<title>A &amp; B</title><script>const s = "<link rel=canonical href=/x/>"</script><!-- <a href="/b/"> --><a href="/c">c</a>')
  assert.deepEqual(p, { title: 'A & B', canonicals: [], noindex: false, redirect: false, links: ['/c'] })
})

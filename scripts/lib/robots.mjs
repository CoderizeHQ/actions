// robots.txt for a site kept out of search (platform's noindex exception), shared by ci-site's SEO check and release:
// "closed to every crawler" means no crawler may fetch anything, whatever group it falls into. A crawler follows the
// most specific group naming it and only that one, so a `User-agent: *` group with `Disallow: /` isn't enough when
// another group (Googlebot, say) allows something, and an `Allow:` line opens what `Disallow: /` closed.

/**
 * The robots.txt groups, each { agents, rules: [{ field, value }] }. Consecutive User-agent lines share one group;
 * lines before any User-agent are ignored, as crawlers ignore them.
 * @param {string} text
 */
export function robotsGroups(text) {
  const groups = []
  let group = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const field = m[1].toLowerCase()
    const value = m[2].trim()
    if (field === 'user-agent') {
      if (!group || group.closed) {
        group = { agents: [], rules: [], closed: false }
        groups.push(group)
      }
      group.agents.push(value.toLowerCase())
    } else if (field !== 'sitemap' && group) {
      // Any other line in a group (a rule, Crawl-delay, ...) ends its run of User-agent lines: the next one starts a
      // new group. Sitemap lines belong to no group.
      group.closed = true
      if (field === 'disallow' || field === 'allow') group.rules.push({ field, value })
    }
  }
  return groups.map(({ agents, rules }) => ({ agents, rules }))
}

/**
 * Why a robots.txt doesn't close the site to every crawler ([] when it does): a `User-agent: *` group must exist, and
 * every group must have `Disallow: /` and no `Allow:` with a path.
 * @param {string} text
 * @returns {string[]}
 */
export function notClosedToEveryCrawler(text) {
  const groups = robotsGroups(text)
  const problems = []
  if (!groups.some((g) => g.agents.includes('*'))) problems.push('robots.txt has no `User-agent: *` group')
  for (const g of groups) {
    const who = g.agents.join(', ')
    if (!g.rules.some((r) => r.field === 'disallow' && r.value === '/')) problems.push(`robots.txt's group for ${who} doesn't disallow /`)
    for (const r of g.rules) if (r.field === 'allow' && r.value !== '') problems.push(`robots.txt's group for ${who} allows ${r.value}`)
  }
  return problems
}

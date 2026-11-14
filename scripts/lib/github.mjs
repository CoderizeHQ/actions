// A small GitHub REST client on fetch: no dependencies, so the release check runs without an install.

const API = 'https://api.github.com'

/**
 * @param {string} token
 * @param {string} path e.g. `/repos/o/r/pulls/1`
 * @param {{ method?: string, body?: unknown }} [opts]
 * @returns {Promise<any>} the parsed body, or null on 404
 */
export async function gh(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: ${res.status}`)
  return res.status === 204 ? null : res.json()
}

/**
 * Every item of a paged list. `pick` gets each page's body and returns its items (for endpoints that wrap them).
 * @param {string} token @param {string} path @param {(page: any) => any[]} [pick]
 */
export async function ghAll(token, path, pick = (p) => p ?? []) {
  const items = []
  const sep = path.includes('?') ? '&' : '?'
  for (let page = 1; page <= 50; page++) {
    const batch = pick(await gh(token, `${path}${sep}per_page=100&page=${page}`))
    items.push(...batch)
    if (batch.length < 100) return items
  }
  throw new Error(`more than 5000 items at ${path.split('?')[0]}`)
}

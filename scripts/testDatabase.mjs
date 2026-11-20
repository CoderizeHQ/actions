// ci-node's test database (STANDARDS.md 6). With `test-database: true`, ci-node makes an empty database for this job
// alone just before the tests and drops it right after, whatever happened. No credentials and no Neon: the database
// lives on a CI-only Postgres that holds nothing but test fixtures.
//
// Where the Postgres is (the admin URL), in order:
//   CODERIZEHQ_TEST_DB  set by the runner VM's autoscaler on every job container (CoderizeHQ/runners): the `test-db`
//                       container on the jobs network, Postgres 18 on a RAM disk, reachable from job containers only
//   TEST_DB_ADMIN_URL   set by ci-node's own fallback on a GitHub-hosted runner: the image's own PostgreSQL 18,
//                       started for the job and listening on localhost only
// Either way the URL names the role `ci` (LOGIN CREATEDB, not a superuser) and no password: that server's pg_hba
// trusts `ci` from those addresses, and no other role can log in over the network (the VM's refuses them outright; on
// the hosted image they'd need a password, and none has one). There is no password to leak, and the URLs printed here
// and handed to the tests carry none.
//
// Each job's database is `ci_<unix seconds>_<12 random hex>`, so concurrent jobs never share one. Before making its
// own, a job drops any `ci_` database older than three hours (best effort): the database is made inside the ci-node
// job, whose timeout is 60 minutes, so nothing that old is still in use. The tests get the same URL as DATABASE_URL
// and DIRECT_URL (there is no pooler); the repo's test setup must migrate the empty database.
//
//   node scripts/testDatabase.mjs create        sweeps, makes the database, writes `name`, `url` and `admin` to
//                                               GITHUB_OUTPUT
//   node scripts/testDatabase.mjs drop <name>   drops it (WITH (FORCE): the tests' connections may still be open)

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

import { output, runIfMain } from './lib/report.mjs'

export const PREFIX = 'ci_'
// Production's major (Neon, coderize-clients: pg_version 18). Another major is a warning, not a failure.
export const PG_MAJOR = 18
// Three times ci-node's 60-minute job timeout. The database is made inside that job, so runner queue time doesn't count.
export const MAX_AGE_S = 3 * 60 * 60
const NAME = /^ci_(\d{10})_[0-9a-f]{12}$/

/** This job's database name: ci_<unix seconds>_<12 random hex>, well inside Postgres's 63-character limit. */
export function databaseName(now = Date.now(), random = randomBytes) {
  return `${PREFIX}${Math.floor(now / 1000)}_${random(6).toString('hex')}`
}

/** Whether a database is one of ours, by its exact name shape. Everything else on the server is left alone. */
export function isOurs(name) {
  return NAME.test(name)
}

/** Our databases older than MAX_AGE_S, by the time in their name. */
export function stale(names, now = Date.now()) {
  const nowS = Math.floor(now / 1000)
  return names.filter((n) => isOurs(n) && nowS - Number(NAME.exec(n)[1]) > MAX_AGE_S)
}

/** The admin URL pointed at another database. Refuses a URL with a password: this server never has one. */
export function withDatabase(adminUrl, database) {
  let url
  try {
    url = new URL(adminUrl)
  } catch {
    throw new Error('testDatabase: the admin URL is not a URL')
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error('testDatabase: the admin URL is not a postgresql:// URL')
  if (url.password) throw new Error('testDatabase: the admin URL carries a password; the CI Postgres takes none')
  url.pathname = `/${database}`
  return url.toString()
}

/** Where the CI Postgres is, or a clear error when this runner has none. */
export function adminUrl(env = process.env) {
  const url = env.CODERIZEHQ_TEST_DB || env.TEST_DB_ADMIN_URL
  if (!url) {
    throw new Error(
      'test-database needs the coderizehq-runners pool (which sets CODERIZEHQ_TEST_DB) or a GitHub-hosted Ubuntu runner (whose own PostgreSQL ci-node starts); this runner has neither',
    )
  }
  return url
}

/** Runs one statement through psql and returns its unaligned output. `exec` is for tests. */
export function psql(url, sql, exec = execFileSync) {
  return String(
    exec('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', url, '-c', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    }),
  ).trim()
}

function quoted(name) {
  if (!isOurs(name)) throw new Error(`testDatabase: refusing "${name}", which isn't a ci_ test database name`)
  return `"${name}"`
}

/** Sweeps stale databases (best effort), makes this job's, and returns its name and URL. */
export function create({ admin, run = psql, now = Date.now(), random = randomBytes, log = console.log }) {
  const versionNum = Number(run(admin, 'SHOW server_version_num'))
  const major = Math.floor(versionNum / 10000)
  if (major !== PG_MAJOR) {
    log(`::warning::the CI Postgres is major ${major || 'unknown'}, but production runs ${PG_MAJOR}`)
  }

  const names = run(admin, `SELECT datname FROM pg_database WHERE datname LIKE 'ci\\_%'`).split('\n').filter(Boolean)
  for (const name of stale(names, now)) {
    try {
      run(admin, `DROP DATABASE IF EXISTS ${quoted(name)} WITH (FORCE)`)
      log(`Swept the leftover test database ${name}`)
    } catch (err) {
      // Another job may be sweeping the same one; the next sweep catches anything left.
      log(`::warning::couldn't sweep ${name}: ${String(err?.message ?? err).split('\n')[0]}`)
    }
  }

  const name = databaseName(now, random)
  run(admin, `CREATE DATABASE ${quoted(name)}`)
  log(`Made the test database ${name} (Postgres ${major}, ${new URL(admin).host})`)
  return { name, url: withDatabase(admin, name) }
}

/** Drops this job's database, closing any connection the tests left open. */
export function drop({ admin, name, run = psql, log = console.log }) {
  run(admin, `DROP DATABASE IF EXISTS ${quoted(name)} WITH (FORCE)`)
  log(`Dropped the test database ${name}`)
}

runIfMain(import.meta.url, async () => {
  const [command, name] = process.argv.slice(2)
  const admin = adminUrl()
  if (command === 'create') {
    const made = create({ admin })
    output('name', made.name)
    output('url', made.url)
    output('admin', admin)
  } else if (command === 'drop') {
    drop({ admin, name })
  } else {
    throw new Error('usage: testDatabase.mjs create | drop <name>')
  }
})

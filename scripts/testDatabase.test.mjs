import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

import { MAX_AGE_S, PG_MAJOR, adminUrl, create, databaseName, drop, isOurs, psql, stale, withDatabase } from './testDatabase.mjs'

const NOW = Date.parse('2026-11-20T12:00:00Z')
const NOW_S = NOW / 1000
const fixedRandom = () => Buffer.from('a1b2c3d4e5f6', 'hex')
const ADMIN = 'postgresql://ci@test-db:5432/postgres'

test('databaseName is ci_<seconds>_<12 hex>, and isOurs accepts only that shape', () => {
  assert.equal(databaseName(NOW, fixedRandom), `ci_${NOW_S}_a1b2c3d4e5f6`)
  assert.ok(isOurs(databaseName()))
  for (const name of ['postgres', 'template1', 'ci', 'ci_123_a1b2c3d4e5f6', `ci_${NOW_S}_A1B2C3D4E5F6`, `ci_${NOW_S}_a1b2c3d4e5f6"; DROP`]) {
    assert.equal(isOurs(name), false, name)
  }
})

test('stale picks only our databases older than three hours', () => {
  const old = `ci_${NOW_S - MAX_AGE_S - 1}_000000000001`
  const fresh = `ci_${NOW_S - 60 * 60}_000000000002`
  assert.deepEqual(stale([old, fresh, 'postgres', 'ci_other'], NOW), [old])
})

test('withDatabase swaps the database and refuses a password or another scheme', () => {
  assert.equal(withDatabase(ADMIN, 'ci_1_x'), 'postgresql://ci@test-db:5432/ci_1_x')
  assert.equal(withDatabase('postgresql://ci@127.0.0.1:5432/postgres', 'd'), 'postgresql://ci@127.0.0.1:5432/d')
  assert.throws(() => withDatabase('postgresql://ci:pw@test-db:5432/postgres', 'd'), /password/)
  assert.throws(() => withDatabase('http://test-db/postgres', 'd'), /postgresql/)
  assert.throws(() => withDatabase('not a url', 'd'), /not a URL/)
})

test('adminUrl prefers the runner VM, then the hosted fallback, else says what is missing', () => {
  assert.equal(adminUrl({ CODERIZEHQ_TEST_DB: ADMIN, TEST_DB_ADMIN_URL: 'postgresql://ci@127.0.0.1/postgres' }), ADMIN)
  assert.equal(adminUrl({ TEST_DB_ADMIN_URL: 'postgresql://ci@127.0.0.1/postgres' }), 'postgresql://ci@127.0.0.1/postgres')
  assert.throws(() => adminUrl({}), /coderizehq-runners pool .* GitHub-hosted/)
})

test('psql runs one statement with ON_ERROR_STOP and no psqlrc, never through a shell', () => {
  const calls = []
  const out = psql(ADMIN, 'SELECT 1', (file, args, opts) => {
    calls.push({ file, args, opts })
    return ' 1\n'
  })
  assert.equal(out, '1')
  assert.equal(calls[0].file, 'psql')
  assert.deepEqual(calls[0].args, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', ADMIN, '-c', 'SELECT 1'])
  assert.equal(calls[0].opts.shell, undefined)
})

/** A fake psql: answers the version and the list, records everything else. */
function fakeRun({ version = `${PG_MAJOR}0006`, names = [], failOn } = {}) {
  const sql = []
  const run = (url, statement) => {
    sql.push({ url, statement })
    if (failOn && statement.includes(failOn)) throw new Error('database is being accessed by other users\nmore')
    if (statement === 'SHOW server_version_num') return version
    if (statement.startsWith('SELECT datname')) return names.join('\n')
    return ''
  }
  return { run, sql }
}

test('create sweeps stale databases, makes its own and returns a URL without a password', () => {
  const old = `ci_${NOW_S - MAX_AGE_S - 60}_00000000000a`
  const fresh = `ci_${NOW_S - 600}_00000000000b`
  const { run, sql } = fakeRun({ names: [old, fresh] })
  const logs = []
  const made = create({ admin: ADMIN, run, now: NOW, random: fixedRandom, log: (l) => logs.push(l) })

  assert.equal(made.name, `ci_${NOW_S}_a1b2c3d4e5f6`)
  assert.equal(made.url, `postgresql://ci@test-db:5432/ci_${NOW_S}_a1b2c3d4e5f6`)
  const statements = sql.map((s) => s.statement)
  assert.ok(statements.includes(`DROP DATABASE IF EXISTS "${old}" WITH (FORCE)`))
  assert.ok(!statements.some((s) => s.includes(fresh)), 'a fresh database is left alone')
  assert.equal(statements.at(-1), `CREATE DATABASE "${made.name}"`)
  assert.ok(sql.every((s) => s.url === ADMIN), 'every admin statement goes to the admin URL')
  assert.ok(!logs.some((l) => l.startsWith('::warning::')))
})

test('create warns on another Postgres major, and a failed sweep does not stop it', () => {
  const old = `ci_${NOW_S - MAX_AGE_S - 60}_00000000000a`
  const { run, sql } = fakeRun({ version: '170004', names: [old], failOn: `DROP DATABASE IF EXISTS "${old}"` })
  const logs = []
  const made = create({ admin: ADMIN, run, now: NOW, random: fixedRandom, log: (l) => logs.push(l) })
  assert.ok(logs.some((l) => l.startsWith('::warning::the CI Postgres is major 17')))
  assert.ok(logs.some((l) => l.startsWith(`::warning::couldn't sweep ${old}`) && !l.includes('more')))
  assert.equal(sql.at(-1).statement, `CREATE DATABASE "${made.name}"`)
})

test('drop forces the drop of a ci_ database and refuses any other name', () => {
  const { run, sql } = fakeRun()
  const name = `ci_${NOW_S}_a1b2c3d4e5f6`
  drop({ admin: ADMIN, name, run, log: () => {} })
  assert.equal(sql[0].statement, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  for (const bad of ['postgres', undefined, 'ci_1_x', `${name}"; DROP DATABASE "postgres`]) {
    assert.throws(() => drop({ admin: ADMIN, name: bad, run, log: () => {} }), /refusing/)
  }
  assert.equal(sql.length, 1)
})

// In CI (actions' own ci.yml turns test-database on) this runs against the database ci-node made for this job, on the
// runner VM's test-db or the GitHub-hosted runner's own PostgreSQL. Elsewhere it is skipped.
test('the database ci-node made is empty, writable, and Postgres ' + PG_MAJOR, { skip: !process.env.DATABASE_URL && 'no DATABASE_URL (not in CI with test-database)' }, () => {
  const url = process.env.DATABASE_URL
  assert.equal(process.env.DIRECT_URL, url)
  const database = new URL(url).pathname.slice(1)
  assert.ok(isOurs(database), `${database} is a ci_ test database`)
  assert.equal(new URL(url).password, '')
  const run = (sql) => execFileSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', url, '-c', sql], { encoding: 'utf8' }).trim()
  assert.equal(run(`SELECT count(*) FROM pg_tables WHERE schemaname = 'public'`), '0')
  assert.equal(run('SELECT current_user'), 'ci')
  assert.equal(run('SELECT rolsuper FROM pg_roles WHERE rolname = current_user'), 'f')
  assert.equal(Math.floor(Number(run('SHOW server_version_num')) / 10000), PG_MAJOR)
  run('CREATE TABLE ci_probe (id int PRIMARY KEY, note text)')
  run(`INSERT INTO ci_probe VALUES (1, 'fixture')`)
  assert.equal(run('SELECT note FROM ci_probe WHERE id = 1'), 'fixture')
})

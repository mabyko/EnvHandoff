import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { Database } from '../src/database.ts'
import { Deletions } from '../src/deletions.ts'

test('real HTTP server accepts beta JSON bodies and preserves authentication, size and rate limits', { timeout: 60_000 }, async t => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgresql://envhandoff:local-development-only@127.0.0.1:55432/envhandoff_test')
  assert.match(url.pathname, /^\/[a-z0-9_]+_test$/, 'Use a dedicated test database')
  // CREATE/DROP DATABASE can wait for a cluster checkpoint while other tests write.
  // Give only this isolated test's administrative DDL a bounded longer timeout;
  // application connections retain their normal 15-second statement timeout.
  const admin = new Client({ connectionString: url.href, connectionTimeoutMillis: 5000, statement_timeout: 45_000 });
  const name = 'http_' + randomUUID().replaceAll('-', '') + '_test'
  const root = await mkdtemp(join(tmpdir(), 'envhandoff-http-'))
  let db: Database | undefined, stop = async () => {}
  t.after(async () => {
    await stop(); await db?.close()
    try { await admin.query(`DROP DATABASE IF EXISTS ${name}`) }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  })
  // The entry point uses the public schema; give its child process an isolated database.
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  url.pathname = '/' + name
  db = new Database(url.href); await db.migrate()
  await Deletions.initialize(join(root, 'ledger'))
  const users = []
  for (let n = 1; n <= 2; n++) {
    const id = randomUUID(), token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url')
    const hash = createHash('sha256').update(token).digest('base64url')
    await db.run('INSERT INTO users(id,github_id,login) VALUES($1,$2,$3)', id, String(n), 'http-user' + n)
    await db.run('INSERT INTO sessions VALUES($1,$2,$3,$4,$4)', hash, id, csrf, Date.now())
    users.push({ id, token, csrf, hash })
  }
  const [operator, member] = users
  const reservation = createServer().listen(0, 'localhost')
  await once(reservation, 'listening')
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const apiOrigin = 'http://localhost:' + port, webOrigin = 'http://localhost:5173'
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    env: { ...process.env, NODE_ENV: 'development', DATABASE_URL: url.href, PORT: String(port),
      API_ORIGIN: apiOrigin, WEB_ORIGIN: webOrigin, GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test',
      PRO_OPERATOR_GITHUB_ID: '1', PRO_ACCEPT_NEW_TRANSFERS: 'false', CLOUDFLARE_ORIGIN_SECRET: '', TOTP_ENCRYPTION_KEY: '',
      DELETION_LEDGER_PATH: join(root, 'ledger'), FILE_STORAGE_PATH: join(root, 'objects') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = once(child, 'close')
  stop = async () => { child.kill('SIGTERM'); await closed }
  await new Promise<void>((resolve, reject) => {
    let output = ''
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('EnvHandoff API ready:')) resolve() })
    child.stderr.on('data', chunk => { output += chunk })
    child.once('error', reject)
    child.once('exit', () => reject(new Error('Server startup failed: ' + output)))
  })
  const post = (path: string, body: unknown, user = operator!, headers: Record<string, string> = {}) => fetch(apiOrigin + path, {
    method: 'POST', signal: AbortSignal.timeout(5000), headers: { origin: webOrigin, 'content-type': 'application/json',
      cookie: 'envhandoff-dev-session=' + user.token, 'x-csrf-token': user.csrf, ...headers }, body: JSON.stringify(body),
  })
  for (const path of ['/beta/codes', '/beta/redeem', '/beta/codes/revoke']) {
    assert.equal((await post(path, {}, operator, { cookie: '' })).status, 401, path + ' must reach session validation instead of rejecting its JSON body')
  }
  const input = { label: 'MABYKO 팀원', maxUses: 1, days: 7 }
  const unverified = await post('/beta/codes', input)
  assert.equal(unverified.status, 403)
  assert.equal((await unverified.json()).error, 'reauthentication_required')
  await db.run('INSERT INTO reauthentications VALUES($1,$2)', operator!.hash, Date.now())
  assert.equal((await post('/beta/codes', input, operator, { 'x-csrf-token': '' })).status, 403)
  assert.equal((await post('/beta/codes', input, operator, { origin: 'https://evil.example' })).status, 403)
  const oversized = await post('/beta/codes', { ...input, label: 'x'.repeat(9000) })
  assert.equal(oversized.status, 413)
  assert.equal((await oversized.json()).error, 'body_too_large')
  const issued = await post('/beta/codes', input)
  assert.equal(issued.status, 200)
  const code = await issued.json()
  const redeemed = await post('/beta/redeem', { code: code.code }, member)
  assert.equal(redeemed.status, 200)
  assert.equal((await redeemed.json()).active, true)
  assert.equal((await post('/beta/codes/revoke', { id: code.id })).status, 200)
  assert.deepEqual(await db.get('SELECT used,revoked FROM beta_codes WHERE id=$1', code.id), { used: 1, revoked: 1 })
  assert.equal((await post('/auth/logout', {})).status, 413, 'Bodyless auth routes must remain restricted')
  let limited: Response | undefined
  for (let n = 0; n < 20; n++) {
    limited = await post('/beta/codes', {}, operator, { cookie: '' })
    if (limited.status === 429) break
    assert.equal(limited.status, 401)
  }
  assert.equal(limited!.status, 429, 'Beta mutations must share the HTTP rate limit')
  assert.equal(limited!.headers.get('retry-after'), '600')
})

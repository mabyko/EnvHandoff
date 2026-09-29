import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { deletionHealth } from '../src/deletion-health.ts'
import { testDatabase } from './database.ts'

const HOUR = 3_600_000, DAY = 24 * HOUR

test('deletion health detects exact deadlines without changing objects, identities or writer leases', async t => {
  const db = (await testDatabase(t)).connect(), now = 1_800_000_000_000
  const empty = { stalledUploads: { count: 0, oldestAgeMs: null }, overdueDeletions: { count: 0, oldestAgeMs: null } }
  assert.deepEqual(await deletionHealth(db, now), { status: 'ok', checkedAt: now, uploads: empty, externalShares: empty })
  for (const table of ['uploads', 'external_shares']) {
    const add = async (status: string, created: number, ended: number | null = null, deleted: number | null = null, lease: number | null = null) => {
      const id = randomUUID()
      if (table === 'uploads') {
        await db.run(`INSERT INTO file_requests(id,org_id,environment_id,receiver_id,sender_id,receiver_device_id,status,created_at,expires_at)
          VALUES($1,'private-org','private-env','receiver','sender','private-device','approved',$2,$3)`, id, created, now + DAY)
        await db.run(`INSERT INTO uploads(id,request_id,org_id,sender_id,sender_device_id,project_id,size,digest,retention_days,status,
          created_at,ended_at,deleted_at,write_until,sender_identity,receiver_identity)
          VALUES($1,$1,'private-org','sender','private-device','private-project',174,'private-digest',1,$2,$3,$4,$5,$6,'private-sender-key','private-receiver-key')`,
        id, status, created, ended, deleted, lease)
      } else {
        await db.run(`INSERT INTO external_shares(id,org_id,environment_id,creator_id,size,digest,retention_days,token_hash,status,
          created_at,ended_at,deleted_at,write_until) VALUES($1,'private-org','private-env','sender',174,'private-digest',1,'private-token-hash',$2,$3,$4,$5,$6)`,
        id, status, created, ended, deleted, lease)
      }
    }
    await add('reserved', now - HOUR + 1) // Still inside the upload deadline.
    await add('reserved', now - HOUR)
    await add('writing', now - 2 * HOUR, null, null, now + HOUR) // An anomalous live lease does not hide a delay.
    await add('committed', now - 7 * DAY) // Valid older delivery; creation age alone is not a failure.
    await add('failed', now - DAY - HOUR, now - DAY + 1)
    await add('failed', now - DAY - HOUR, now - DAY)
    await add('cancelled', now - 2 * DAY - HOUR, now - 2 * DAY, null, now + HOUR)
    await add('committed', now - 7 * DAY, now - 3 * DAY) // Ended deliveries retain their committed storage status.
    await add('failed', now - 10 * DAY, now - 9 * DAY, now - 8 * DAY) // Confirmed deletion is excluded.
  }
  const before = await Promise.all(['uploads', 'external_shares'].map(table => db.all(`SELECT * FROM ${table} ORDER BY id`)))
  const health = await deletionHealth(db, now)
  const expected = { stalledUploads: { count: 2, oldestAgeMs: 2 * HOUR }, overdueDeletions: { count: 3, oldestAgeMs: 3 * DAY } }
  assert.deepEqual(health, { status: 'delayed', checkedAt: now, uploads: expected, externalShares: expected })
  assert.doesNotMatch(JSON.stringify(health), /private-|sender|receiver|token|digest/)
  assert.deepEqual(await Promise.all(['uploads', 'external_shares'].map(table => db.all(`SELECT * FROM ${table} ORDER BY id`))), before)
  const earlier = await deletionHealth(db, now - 1)
  assert.equal(earlier.uploads.stalledUploads.count, 1)
  assert.equal(earlier.externalShares.overdueDeletions.count, 2)
  await db.run("UPDATE uploads SET status='failed',ended_at=$1 WHERE ended_at IS NULL AND status IN ('reserved','writing')", now)
  await db.run("UPDATE external_shares SET status='failed',ended_at=$1 WHERE ended_at IS NULL AND status IN ('reserved','writing')", now)
  await db.run('UPDATE uploads SET deleted_at=$1 WHERE ended_at<=$2', now, now - DAY)
  await db.run('UPDATE external_shares SET deleted_at=$1 WHERE ended_at<=$2', now, now - DAY)
  assert.equal((await deletionHealth(db, now)).status, 'ok')
  await assert.rejects(deletionHealth(db, Number.NaN), /Invalid observation time/)
})

test('deletion health CLI help needs no database or ledger and errors do not expose connection secrets', () => {
  const script = fileURLToPath(new URL('../src/deletion-health.ts', import.meta.url))
  const env = { ...process.env, DATABASE_URL: 'invalid://private-user:private-password@private-host', DELETION_LEDGER_PATH: '' }
  const help = spawnSync(process.execPath, [script, '--help'], { env, encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /0 healthy, 1 delayed, 2 check failed/)
  assert.equal(help.stderr, '')
  for (const args of [[], ['--apply'], ['--help', '--apply']]) {
    const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Deletion health check failed/)
    assert.doesNotMatch(result.stderr, /private-/)
  }
})

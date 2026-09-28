import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fixture } from './request-fixture.ts'
import { disableAccount } from '../src/disable-account.ts'
import { Deletions } from '../src/deletions.ts'

test('account suspension previews safely, checks both IDs and atomically invalidates the target only', async t => {
  const f = await fixture(t), ledger = new Deletions(f.localConfig.deletionLedgerPath), request = await f.create()
  await f.organizations.setPermissions(f.owner.id, f.orgId, f.environment.id, f.sender.id, true, true, true)
  const shareId = randomUUID(), outgoing = randomUUID(), incoming = randomUUID()
  await f.db.run(`INSERT INTO external_shares(id,org_id,environment_id,creator_id,size,digest,retention_days,token_hash,status,created_at,available_until)
    VALUES($1,$2,$3,$4,40,'fake-digest',1,'fake-token-hash','committed',$5,$6)`, shareId, f.orgId, f.environment.id, f.sender.id, f.now(), f.now() + 86_400_000)
  for (const [id, issuer, target] of [[outgoing, f.sender.id, '999'], [incoming, f.owner.id, '3']]) {
    await f.db.run(`INSERT INTO invitations(id,token_hash,kind,org_id,team_id,target_id,target_login,issuer_id,created_at,expires_at)
      VALUES($1,$2,'member',$3,$4,$5,'fake-login',$6,$7,$8)`, id, randomBytes(32).toString('base64url'), f.orgId, f.teamId, target, issuer, f.now(), f.now() + 86_400_000)
  }
  await f.db.run('INSERT INTO oauth_flows VALUES($1,$2,$3,$4,$5)', randomUUID(), 'fake-browser', 'fake-verifier', f.sender.hash, f.now() + 60_000)
  const before = await f.db.all('SELECT * FROM sessions ORDER BY user_id')
  const preview = await disableAccount(f.db, ledger, f.sender.id, '3', false, f.now())
  assert.equal(preview.applied, false); assert.equal(preview.auditRecorded, true); assert.equal(preview.sessions, 1)
  assert.deepEqual(await f.db.all('SELECT * FROM sessions ORDER BY user_id'), before)
  assert.equal((await f.db.get('SELECT disabled FROM users WHERE id=$1', f.sender.id))!.disabled, 0)
  assert.equal((await f.db.get('SELECT ended_at FROM external_shares WHERE id=$1', shareId))!.ended_at, null)
  await assert.rejects(disableAccount(f.db, ledger, f.sender.id, '2', true, f.now()), /identity_mismatch/)
  await assert.rejects(disableAccount(f.db, ledger, 'invalid', '3', true, f.now()), /invalid_user_id/)
  await assert.rejects(disableAccount(f.db, ledger, f.sender.id, '03', true, f.now()), /invalid_github_id/)
  await assert.rejects(f.db.transaction(async () => {
    await disableAccount(f.db, ledger, f.sender.id, '3', true, f.now())
    throw new Error('rollback suspension')
  }), /rollback suspension/)
  assert.deepEqual(await f.db.all('SELECT * FROM sessions ORDER BY user_id'), before)
  assert.equal((await f.db.get("SELECT count(*) AS n FROM auth_events WHERE event='account_disabled'"))!.n, 0)
  const applied = await disableAccount(f.db, ledger, f.sender.id, '3', true, f.now())
  assert.equal(applied.applied, true); assert.equal(applied.wasDisabled, false)
  assert.equal((await f.db.get('SELECT disabled FROM users WHERE id=$1', f.sender.id))!.disabled, 1)
  assert.equal(await f.db.get('SELECT 1 FROM sessions WHERE user_id=$1', f.sender.id), undefined)
  assert.equal(await f.db.get('SELECT 1 FROM oauth_flows WHERE previous_session=$1', f.sender.hash), undefined)
  assert.equal((await f.db.get('SELECT count(*) AS n FROM sessions'))!.n, before.length - 1)
  assert.equal((await f.db.get('SELECT status FROM file_requests WHERE id=$1', request.id))!.status, 'cancelled')
  assert.equal((await f.db.get('SELECT revoked_at FROM external_shares WHERE id=$1', shareId))!.revoked_at, f.now())
  assert.equal((await f.db.get("SELECT count(*) AS n FROM invitations WHERE id=ANY($1::text[]) AND status='cancelled'", [incoming, outgoing]))!.n, 2)
  assert.equal((await disableAccount(f.db, ledger, f.sender.id, '3', true, f.now() + 1)).wasDisabled, true)
  assert.equal((await f.db.get('SELECT revoked_at FROM external_shares WHERE id=$1', shareId))!.revoked_at, f.now())
  assert.equal((await disableAccount(f.db, ledger, f.owner.id, '1', true, f.now())).applied, true)
  assert.equal((await f.db.get("SELECT role FROM memberships WHERE user_id=$1 AND org_id=$2", f.owner.id, f.orgId))!.role, 'owner')
})

test('permanent deletion wins over suspension and CLI errors do not expose inputs or credentials', async t => {
  const f = await fixture(t), ledger = new Deletions(f.localConfig.deletionLedgerPath)
  await ledger.record('user', f.sender.id, f.now())
  await assert.rejects(disableAccount(f.db, ledger, f.sender.id, '3', true, f.now()), /identity_mismatch/)
  assert.equal((await f.db.get("SELECT count(*) AS n FROM auth_events WHERE event='account_disabled'"))!.n, 0)
  await ledger.sync(f.db, f.now())
  assert.equal(await f.db.get('SELECT 1 FROM users WHERE id=$1', f.sender.id), undefined)
  const run = promisify(execFile), cli = new URL('../src/disable-account.ts', import.meta.url).pathname
  const env = { ...process.env, DATABASE_URL: 'postgres://sensitive-example', DELETION_LEDGER_PATH: '' }
  const help = await run(process.execPath, [cli, '--help'], { env })
  assert.match(help.stdout, /Default is a preview/); assert.equal(help.stderr, '')
  await assert.rejects(run(process.execPath, [cli, 'private-input', '3', '--apply'], { env }), (error: unknown) => {
    const result = error as { code: number; stdout: string; stderr: string }
    assert.equal(result.code, 1); assert.equal(result.stdout, '')
    assert.match(result.stderr, /invalid_user_id/); assert.doesNotMatch(result.stderr, /private-input|sensitive-example/)
    return true
  })
})

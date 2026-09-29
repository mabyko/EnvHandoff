import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fixture } from './request-fixture.ts'
import { blockRestoredTransfers } from '../src/restore-safe.ts'

test('disaster restore preview preserves data; apply atomically closes deliveries and cannot reopen them', async t => {
  const f = await fixture(t), request = await f.create(), pending = await f.create(), uploadId = randomUUID(), shareId = randomUUID()
  await f.db.run("UPDATE file_requests SET status='fulfilled',ended_at=$1 WHERE id=$2", f.now(), request.id)
  await f.db.run(`INSERT INTO uploads(id,request_id,org_id,sender_id,sender_device_id,project_id,size,digest,
    retention_days,status,created_at,available_until,acknowledged_at,sender_identity,receiver_identity)
    VALUES($1,$2,$3,$4,$5,$6,174,'test',1,'committed',$7,$8,$7,'{}','{}')`,
  uploadId, request.id, f.orgId, f.sender.id, f.identity.deviceId, f.project.id, f.now(), f.now() + 86_400_000)
  await f.db.run(`INSERT INTO external_shares(id,org_id,environment_id,creator_id,size,digest,retention_days,
    token_hash,status,created_at,write_until) VALUES($1,$2,$3,$4,174,'test',1,'old-token-hash','writing',$5,$6)`,
  shareId, f.orgId, f.environment.id, f.sender.id, f.now(), f.now() + 120_000)
  await f.db.run('INSERT INTO share_operations VALUES($1,$2,$3,$4,$5)', f.sender.id, randomUUID(), shareId, 'old-input-hash', f.now())
  await f.db.run('INSERT INTO transfer_challenges VALUES($1,$2,$3,$4,$5,$6)', randomUUID(), f.sender.hash, uploadId, '{}', 'old-secret-hash', f.now() + 60_000)
  const preserved = ['file_requests','uploads','external_shares','share_operations','transfer_challenges','memberships','environment_permissions','devices']
  const before = await Promise.all(preserved.map(table => f.db.all('SELECT * FROM '+table)))
  assert.deepEqual(await blockRestoredTransfers(f.db, false, f.now()), { applied: false, auditRecorded: true, requests: 1, transfers: 1, shares: 1 })
  assert.deepEqual(await Promise.all(preserved.map(table => f.db.all('SELECT * FROM '+table))), before)
  assert.deepEqual(await f.db.all("SELECT org_id,actor_id,target_id,event,created_at FROM organization_events WHERE event='restored_transfers_previewed'"),
    [{org_id:f.orgId,actor_id:null,target_id:f.orgId,event:'restored_transfers_previewed',created_at:f.now()}])
  assert.equal((await f.db.get('SELECT token_hash FROM external_shares WHERE id=$1', shareId))!.token_hash, 'old-token-hash')
  const now = f.now() + 1000
  await assert.rejects(f.db.transaction(async () => {
    await blockRestoredTransfers(f.db, true, now)
    throw new Error('rollback restoration')
  }), /rollback restoration/)
  assert.equal((await f.db.get('SELECT revoked_at FROM uploads WHERE id=$1', uploadId))!.revoked_at, null)
  assert.equal((await f.db.get("SELECT count(*) AS n FROM organization_events WHERE event='restored_transfers_apply_checked'"))!.n,0)
  assert.deepEqual(await blockRestoredTransfers(f.db, true, now), { applied: true, auditRecorded: true, requests: 1, transfers: 1, shares: 1 })
  assert.equal((await f.db.get('SELECT status FROM file_requests WHERE id=$1', pending.id))!.status, 'cancelled')
  assert.equal((await f.db.get('SELECT status FROM file_requests WHERE id=$1', request.id))!.status, 'fulfilled')
  assert.deepEqual(await f.db.get('SELECT revoked_at,acknowledged_at,deleted_at FROM uploads WHERE id=$1', uploadId),
    { revoked_at: now, acknowledged_at: f.now(), deleted_at: null })
  assert.deepEqual(await f.db.get('SELECT status,token_hash,write_until,deleted_at FROM external_shares WHERE id=$1', shareId),
    { status: 'cancelled', token_hash: null, write_until: null, deleted_at: null })
  assert.equal((await f.db.get('SELECT count(*) AS n FROM share_operations'))!.n, 0)
  assert.equal((await f.db.get('SELECT count(*) AS n FROM transfer_challenges'))!.n, 0)
  assert.deepEqual(await blockRestoredTransfers(f.db, true, now + 1000), { applied: true, auditRecorded: true, requests: 0, transfers: 0, shares: 0 })
  assert.equal((await f.db.get('SELECT revoked_at FROM uploads WHERE id=$1', uploadId))!.revoked_at, now)
  assert.deepEqual(await f.db.all("SELECT org_id,target_id,event,created_at FROM organization_events WHERE event='restored_transfers_apply_checked' ORDER BY created_at"),
    [now,now+1000].map(created_at=>({org_id:f.orgId,target_id:f.orgId,event:'restored_transfers_apply_checked',created_at})))
  assert.equal((await f.db.get("SELECT count(*) AS n FROM organization_events WHERE event='restored_transfers_blocked'"))!.n,1)
})

test('empty restore previews and applies remain audited, and CLI help needs no database',async t=>{
  const f=await fixture(t)
  await f.db.run('DELETE FROM organizations')
  for(const apply of [false,true,true]) {
    assert.deepEqual(await blockRestoredTransfers(f.db,apply,f.now()),{applied:apply,auditRecorded:true,requests:0,transfers:0,shares:0})
  }
  assert.deepEqual(await f.db.all("SELECT org_id,target_id,event FROM organization_events WHERE event LIKE 'restored_transfers_%' ORDER BY id"),
    ['restored_transfers_previewed','restored_transfers_apply_checked','restored_transfers_apply_checked'].map(event=>({org_id:null,target_id:'restore-safe',event})))
  const {stdout,stderr}=await promisify(execFile)(process.execPath,[new URL('../src/restore-safe.ts',import.meta.url).pathname,'--help'],{env:{...process.env,DATABASE_URL:'',DELETION_LEDGER_PATH:''}})
  assert.equal(stderr,'');assert.match(stdout,/metadata-read audit/);assert.match(stdout,/auditRecorded:true/);assert.match(stdout,/deletion-ledger/)
})

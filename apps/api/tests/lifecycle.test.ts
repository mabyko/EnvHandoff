import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { fixture } from './request-fixture.ts'
import { invalidateRequests, invalidateShares, invalidateTransfers } from '../src/lifecycle.ts'

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Domain = { orgId: string; projectId: string; environmentId: string };
const hour = 60 * 60_000;

async function prepare(f: Fixture) {
  const deviceIds = new Map([[f.receiver.id, f.identity.deviceId]]);
  for (const user of [f.sender, f.other, f.owner]) {
    const id = randomUUID(); deviceIds.set(user.id, id);
    await f.db.run("INSERT INTO devices VALUES($1,$2,'{}','active')", id, user.id);
  }
  await f.db.run('UPDATE environment_permissions SET receive=1,send=1,external_share=1');
  async function anotherOrganization(): Promise<Domain> {
    const orgId = randomUUID(), projectId = randomUUID(), environmentId = randomUUID(), teamId = randomUUID();
    await f.db.run("INSERT INTO organizations(id,name) VALUES($1,'Second organization')", orgId);
    await f.db.run("INSERT INTO projects VALUES($1,$2,'Project')", projectId, orgId);
    await f.db.run("INSERT INTO environments VALUES($1,$2,'Production')", environmentId, projectId);
    await f.db.run("INSERT INTO teams VALUES($1,$2,'Default',1)", teamId, orgId);
    await f.db.run('INSERT INTO project_teams VALUES($1,$2)', projectId, teamId);
    for (const user of f.users) {
      await f.db.run("INSERT INTO memberships VALUES($1,$2,'member')", orgId, user.id);
      await f.db.run('INSERT INTO team_members VALUES($1,$2)', teamId, user.id);
      await f.db.run('INSERT INTO project_permissions VALUES($1,$2,1,1,1)', projectId, user.id);
    }
    return { orgId, projectId, environmentId };
  }
  async function transfer(domain: Domain, senderId = f.sender.id, receiverId = f.receiver.id, committed = true, expired = false) {
    const requestId = randomUUID(), uploadId = randomUUID(), now = f.now();
    await f.db.run('INSERT INTO file_requests(id,org_id,environment_id,receiver_id,sender_id,receiver_device_id,status,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      requestId, domain.orgId, domain.environmentId, receiverId, senderId, deviceIds.get(receiverId), committed ? 'fulfilled' : 'approved', now - 2 * hour, expired ? now - 1 : now + hour);
    await f.db.run(`INSERT INTO uploads(id,request_id,org_id,sender_id,sender_device_id,project_id,size,digest,retention_days,status,created_at,available_until,sender_identity,receiver_identity)
      VALUES($1,$2,$3,$4,$5,$6,174,'digest',1,$7,$8,$9,'{}','{}')`,
      uploadId, requestId, domain.orgId, senderId, deviceIds.get(senderId), domain.projectId, committed ? 'committed' : 'reserved', now, expired ? now - 1 : now + hour);
    return { requestId, uploadId };
  }
  async function share(domain: Domain, creatorId = f.sender.id, committed = true, expired = false) {
    const id = randomUUID();
    await f.db.run(`INSERT INTO external_shares(id,org_id,environment_id,creator_id,size,digest,retention_days,token_hash,status,created_at,available_until)
      VALUES($1,$2,$3,$4,40,'digest',1,'token',$5,$6,$7)`, id, domain.orgId, domain.environmentId, creatorId, committed ? 'committed' : 'reserved', expired ? f.now() - 2 * hour : f.now(), expired ? f.now() - 1 : f.now() + hour);
    return id;
  }
  const domain = { orgId: f.orgId, projectId: f.project.id, environmentId: f.environment.id };
  return { domain, anotherOrganization, transfer, share };
}

async function assertOpen(f: Fixture, transfer: { requestId: string; uploadId: string }) {
  assert.equal((await f.db.get('SELECT ended_at FROM uploads WHERE id=$1', transfer.uploadId))!.ended_at, null);
  assert.equal((await f.db.get('SELECT ended_at FROM file_requests WHERE id=$1', transfer.requestId))!.ended_at, null);
}
async function assertClosed(f: Fixture, transfer: { requestId: string; uploadId: string }) {
  assert.notEqual((await f.db.get('SELECT ended_at FROM uploads WHERE id=$1', transfer.uploadId))!.ended_at, null);
  assert.notEqual((await f.db.get('SELECT ended_at FROM file_requests WHERE id=$1', transfer.requestId))!.ended_at, null);
}

test('organization invalidation closes only affected organization; global maintenance closes the rest', async t => {
  const f = await fixture(t), seed = await prepare(f), foreign = await seed.anotherOrganization();
  const own = [await seed.transfer(seed.domain), await seed.transfer(seed.domain, f.sender.id, f.receiver.id, false)];
  const other = [await seed.transfer(foreign), await seed.transfer(foreign, f.sender.id, f.receiver.id, false)];
  const ownShare = await seed.share(seed.domain), otherShare = await seed.share(foreign);
  await f.db.run('DELETE FROM memberships WHERE user_id=$1', f.sender.id);
  await invalidateRequests(f.db, f.now(), { organizationId: f.orgId });
  for (const transfer of own) await assertClosed(f, transfer);
  for (const transfer of other) await assertOpen(f, transfer);
  assert.equal((await f.db.get('SELECT revoked_at,token_hash FROM external_shares WHERE id=$1', ownShare))!.token_hash, null);
  assert.equal((await f.db.get('SELECT ended_at FROM external_shares WHERE id=$1', otherShare))!.ended_at, null);
  await invalidateRequests(f.db, f.now());
  for (const transfer of other) await assertClosed(f, transfer);
  assert.equal((await f.db.get('SELECT revoked_at FROM external_shares WHERE id=$1', otherShare))!.revoked_at, f.now());
});

test('user invalidation follows sender and receiver across organizations without touching unrelated expired work', async t => {
  const f = await fixture(t), seed = await prepare(f), foreign = await seed.anotherOrganization();
  const affected = [], unrelated = [], affectedShares = [], unrelatedShares = [];
  for (const domain of [seed.domain, foreign]) {
    affected.push(await seed.transfer(domain, f.sender.id, f.receiver.id));
    affected.push(await seed.transfer(domain, f.receiver.id, f.sender.id));
    affected.push(await seed.transfer(domain, f.receiver.id, f.sender.id, false));
    unrelated.push(await seed.transfer(domain, f.other.id, f.receiver.id, true, true));
    affectedShares.push(await seed.share(domain, f.sender.id));
    unrelatedShares.push(await seed.share(domain, f.other.id, true, true));
  }
  await f.db.run('UPDATE users SET disabled=1 WHERE id=$1', f.sender.id);
  await invalidateRequests(f.db, f.now(), { userId: f.sender.id });
  for (const transfer of affected) await assertClosed(f, transfer);
  for (const transfer of unrelated) await assertOpen(f, transfer);
  for (const id of affectedShares) assert.equal((await f.db.get('SELECT revoked_at FROM external_shares WHERE id=$1', id))!.revoked_at, f.now());
  for (const id of unrelatedShares) assert.equal((await f.db.get('SELECT ended_at FROM external_shares WHERE id=$1', id))!.ended_at, null);
  await invalidateRequests(f.db, f.now());
  for (const transfer of unrelated) await assertClosed(f, transfer);
  for (const id of unrelatedShares) assert.equal((await f.db.get('SELECT ended_at FROM external_shares WHERE id=$1', id))!.ended_at, f.now() - 1);
});

test('request scope expires only its request and upload, propagates committed end time and preserves atomic rollback', async t => {
  const f = await fixture(t), seed = await prepare(f);
  const pending = await seed.transfer(seed.domain, f.sender.id, f.receiver.id, false, true);
  const committed = await seed.transfer(seed.domain, f.sender.id, f.receiver.id, true, true);
  const unrelated = await seed.transfer(seed.domain, f.other.id, f.receiver.id, true, true);
  const share = await seed.share(seed.domain, f.sender.id, true, true);
  await assert.rejects(f.db.transaction(async () => {
    await invalidateRequests(f.db, f.now(), { requestId: pending.requestId });
    await assertClosed(f, pending);
    throw new Error('rollback transitions');
  }), /rollback transitions/);
  await assertOpen(f, pending);
  await invalidateRequests(f.db, f.now(), { requestId: pending.requestId });
  assert.equal((await f.db.get('SELECT status FROM file_requests WHERE id=$1', pending.requestId))!.status, 'expired');
  assert.equal((await f.db.get('SELECT status FROM uploads WHERE id=$1', pending.uploadId))!.status, 'cancelled');
  await assertClosed(f, pending); await assertOpen(f, committed); await assertOpen(f, unrelated);
  await invalidateTransfers(f.db, f.now(), { requestId: committed.requestId });
  assert.equal((await f.db.get('SELECT ended_at FROM file_requests WHERE id=$1', committed.requestId))!.ended_at, f.now() - 1);
  await assertClosed(f, committed); await assertOpen(f, unrelated);
  const abandoned = await seed.transfer(seed.domain, f.sender.id, f.receiver.id, false);
  await f.db.run('UPDATE uploads SET created_at=$1 WHERE id=$2', f.now() - 2 * hour, abandoned.uploadId);
  await invalidateTransfers(f.db, f.now(), { requestId: abandoned.requestId });
  assert.deepEqual(await f.db.get('SELECT status,ended_at FROM uploads WHERE id=$1', abandoned.uploadId), { status: 'failed', ended_at: f.now() });
  assert.equal((await f.db.get('SELECT status FROM file_requests WHERE id=$1', abandoned.requestId))!.status, 'approved');
  await assertOpen(f, unrelated);
  assert.equal((await f.db.get('SELECT ended_at FROM external_shares WHERE id=$1', share))!.ended_at, null);
});

test('share scope revokes or expires only its own share and never touches requests or transfers', async t => {
  const f = await fixture(t), seed = await prepare(f);
  const expired = await seed.share(seed.domain, f.sender.id, true, true);
  const abandoned = await seed.share(seed.domain, f.sender.id, false, true);
  const unrelated = await seed.share(seed.domain, f.other.id, true, true);
  const transfer = await seed.transfer(seed.domain, f.sender.id, f.receiver.id, true, true);
  await invalidateRequests(f.db, f.now(), { shareId: expired });
  assert.deepEqual(await f.db.get('SELECT ended_at,revoked_at,token_hash FROM external_shares WHERE id=$1', expired), { ended_at: f.now() - 1, revoked_at: null, token_hash: null });
  assert.equal((await f.db.get('SELECT ended_at FROM external_shares WHERE id=$1', abandoned))!.ended_at, null);
  await invalidateShares(f.db, f.now(), { shareId: abandoned });
  assert.deepEqual(await f.db.get('SELECT ended_at,status,token_hash FROM external_shares WHERE id=$1', abandoned), { ended_at: f.now(), status: 'failed', token_hash: null });
  const revoked = await seed.share(seed.domain, f.sender.id);
  await f.db.run('UPDATE environment_permissions SET external_share=0 WHERE user_id=$1', f.sender.id);
  await invalidateRequests(f.db, f.now(), { shareId: revoked });
  assert.equal((await f.db.get('SELECT revoked_at FROM external_shares WHERE id=$1', revoked))!.revoked_at, f.now());
  assert.equal((await f.db.get('SELECT ended_at FROM external_shares WHERE id=$1', unrelated))!.ended_at, null);
  await assertOpen(f, transfer);
});

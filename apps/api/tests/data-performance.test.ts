import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, config } from './request-fixture.ts'
import { Deletions } from '../src/deletions.ts'

// Count actual Database calls, including get()'s all(), without counting fixture setup.
function countQueries(t: Parameters<typeof fixture>[0], db: Awaited<ReturnType<typeof fixture>>['db']) {
  const all = t.mock.method(db, 'all'), run = t.mock.method(db, 'run');
  return {
    reset() { all.mock.resetCalls(); run.mock.resetCalls() },
    reads: () => all.mock.callCount(), writes: () => run.mock.callCount(),
  };
}

test('applied deletion history is validated with bounded reads and no repeated erasures', async t => {
  const f = await fixture(t), ledger = new Deletions(f.localConfig.deletionLedgerPath), queries = countQueries(t, f.db);
  const session = () => f.api.handle(new Request(config.apiOrigin + '/auth/session', { headers: { cookie: 'envhandoff-dev-session=' + f.owner.token } }));
  await session(); queries.reset(); assert.equal((await session()).status, 200);
  const baseline = queries.reads() + queries.writes();
  for (let i = 0; i < 30; i++) await ledger.record(i % 2 ? 'user' : 'organization', randomUUID(), f.now());
  await ledger.sync(f.db, f.now()); queries.reset();
  assert.deepEqual(await ledger.sync(f.db, f.now()), { users: 15, organizations: 15 });
  assert.equal(queries.reads(), 2); assert.equal(queries.writes(), 0);
  queries.reset(); assert.equal((await session()).status, 200);
  assert.equal(queries.reads() + queries.writes(), baseline);
  t.diagnostic(`Repeated sync: 2 reads / 0 writes; session: ${baseline} queries with 0 or 30 tombstones`);
  await ledger.record('user', f.other.id, f.now());
  const second = new Deletions(f.localConfig.deletionLedgerPath), db2 = f.storage.connect();
  await Promise.all([ledger.sync(f.db, f.now()), second.sync(db2, f.now())]);
  assert.equal(await f.db.get('SELECT 1 FROM users WHERE id=$1', f.other.id), undefined);
  assert.equal((await f.db.get('SELECT count(*) AS n FROM deletion_records'))!.n, 31);
  assert.equal((await f.db.get("SELECT count(*) AS n FROM auth_events WHERE user_id=$1 AND event='account_deleted'", f.other.id))!.n, 1);
  queries.reset(); await ledger.sync(f.db, f.now()); assert.equal(queries.writes(), 0);
});

test('applied markers never hide tampering of an already-durable ledger entry', async t => {
  const f = await fixture(t), ledger = new Deletions(f.localConfig.deletionLedgerPath);
  await ledger.record('user', f.other.id, f.now()); await ledger.sync(f.db, f.now());
  const path = join(f.localConfig.deletionLedgerPath, 'user-' + f.other.id + '.json');
  const original = await readFile(path, 'utf8'); await chmod(path, 0o600);
  await writeFile(path, JSON.stringify({ ...JSON.parse(original), deletedAt: f.now() + 1 }));
  await assert.rejects(ledger.sync(f.db, f.now()), /deletion_ledger_unavailable/);
  assert.ok(await f.db.get('SELECT 1 FROM users WHERE id=$1', f.owner.id));
  await writeFile(path, original); await ledger.sync(f.db, f.now());
});

test('partial restore of children under a still-inactive marked organization is erased again', async t => {
  const f = await fixture(t), ledger = new Deletions(f.localConfig.deletionLedgerPath);
  const cancellation = randomUUID();
  const restoreCancellation = () => f.db.run("INSERT INTO upload_cancellations(user_id,org_id,kind,reservation_id,created_at) VALUES($1,$2,'share',$3,$4)", f.sender.id, f.orgId, cancellation, f.now());
  await restoreCancellation();
  await ledger.record('organization', f.orgId, f.now()); await ledger.sync(f.db, f.now());
  assert.equal(await f.db.get('SELECT 1 FROM upload_cancellations WHERE org_id=$1', f.orgId), undefined);
  await f.db.run('INSERT INTO projects(id,org_id,name) VALUES($1,$2,$3)', f.project.id, f.orgId, 'Restored child');
  assert.equal((await f.db.get('SELECT active FROM organizations WHERE id=$1', f.orgId))!.active, 0);
  await ledger.sync(f.db, f.now());
  assert.equal(await f.db.get('SELECT 1 FROM projects WHERE org_id=$1', f.orgId), undefined);
  // A cancellation alone can be restored while the org tombstone and marker remain.
  await restoreCancellation(); await ledger.sync(f.db, f.now());
  assert.equal(await f.db.get('SELECT 1 FROM upload_cancellations WHERE org_id=$1', f.orgId), undefined);
  assert.equal((await f.db.get('SELECT count(*) AS n FROM deletion_records'))!.n, 1);
});

test('catalog reads stay constant for owners and members as projects and environments grow', async t => {
  const f = await fixture(t), queries = countQueries(t, f.db);
  queries.reset(); await f.organizations.catalog(f.owner.id, f.orgId); const ownerReads = queries.reads();
  queries.reset(); await f.organizations.catalog(f.sender.id, f.orgId); const memberReads = queries.reads();
  for (let i = 0; i < 20; i++) {
    const id = randomUUID();
    await f.db.run('INSERT INTO projects VALUES($1,$2,$3)', id, f.orgId, 'Scale ' + i.toString().padStart(2, '0'));
    await f.db.run('INSERT INTO project_teams VALUES($1,$2)', id, f.teamId);
    for (const name of ['production', 'development', 'staging']) await f.db.run('INSERT INTO environments VALUES($1,$2,$3)', randomUUID(), id, name);
  }
  for (const [user, expectedReads] of [[f.owner, ownerReads], [f.sender, memberReads]] as const) {
    queries.reset(); const catalog = await f.organizations.catalog(user.id, f.orgId);
    assert.equal(catalog.projects.length, 21);
    assert.equal(catalog.projects.reduce((n, project) => n + project.environments.length, 0), 61);
    assert.equal(queries.reads(), expectedReads); assert.equal(queries.writes(), 0);
    assert.deepEqual(catalog.projects.map(p => p.name), catalog.projects.map(p => p.name).sort());
    for (const project of catalog.projects) assert.deepEqual(project.environments.map(e => e.name), project.environments.map(e => e.name).sort());
  }
  t.diagnostic(`Catalog for 1/21 projects and 1/61 environments: owner ${ownerReads}, member ${memberReads} queries`);
});

test('batched catalogs preserve scoped visibility, grant privacy and permission source', async t => {
  const f = await fixture(t), store = f.organizations;
  const defaults = await store.createEnvironment(f.owner.id, f.orgId, f.project.id, 'Production');
  await store.setProjectPermissions(f.owner.id, f.orgId, f.project.id, f.sender.id, true, false, true);
  const privateTeam = await store.createTeam(f.owner.id, f.orgId, 'Private');
  const privateProject = await store.createProject(f.owner.id, f.orgId, 'Private project', [privateTeam.id]);
  const privateEnv = await store.createEnvironment(f.owner.id, f.orgId, privateProject.id, 'Secret');
  await store.setPermissions(f.owner.id, f.orgId, privateEnv.id, f.sender.id, true, true, true);
  const foreignOrg = randomUUID(), foreignTeam = randomUUID(), foreignProject = randomUUID(), foreignEnv = randomUUID();
  await f.db.run('INSERT INTO organizations(id,name) VALUES($1,$2)', foreignOrg, 'Foreign');
  await f.db.run('INSERT INTO teams VALUES($1,$2,$3,1)', foreignTeam, foreignOrg, 'Foreign team');
  await f.db.run('INSERT INTO team_members VALUES($1,$2)', foreignTeam, f.sender.id);
  await f.db.run('INSERT INTO projects VALUES($1,$2,$3)', foreignProject, foreignOrg, 'Foreign project');
  await f.db.run('INSERT INTO environments VALUES($1,$2,$3)', foreignEnv, foreignProject, 'Foreign env');
  await f.db.run('INSERT INTO project_teams VALUES($1,$2)', privateProject.id, foreignTeam);
  await f.db.run('INSERT INTO environment_permissions VALUES($1,$2,1,1,1)', foreignEnv, f.sender.id);
  await f.db.run('INSERT INTO project_permissions VALUES($1,$2,1,1,1)', foreignProject, f.sender.id);
  const member = await store.catalog(f.sender.id, f.orgId);
  assert.deepEqual(member.teams.map(team => team.id), [f.teamId]);
  assert.deepEqual(member.projects.map(project => project.id), [f.project.id]);
  assert.deepEqual(member.projects[0]!.grants, []); assert.deepEqual(member.projects[0]!.teamIds, []);
  assert.ok(member.teams.every(team => team.members.length === 0));
  const inherited = member.projects[0]!.environments.find(env => env.id === defaults.id)!;
  assert.equal(inherited.permissionSource, 'project');
  assert.deepEqual(inherited.permissions, { receive: true, send: false, externalShare: true });
  const overridden = member.projects[0]!.environments.find(env => env.id === f.environment.id)!;
  assert.equal(overridden.permissionSource, 'environment'); assert.deepEqual(overridden.grants, []);
  assert.deepEqual(overridden.permissions, { receive: true, send: true, externalShare: false });
  await f.db.run('DELETE FROM team_members WHERE user_id=$1', f.owner.id);
  const owner = await store.catalog(f.owner.id, f.orgId);
  assert.equal(owner.projects.length, 2);
  assert.ok(!JSON.stringify(owner).includes(foreignOrg)); assert.ok(!JSON.stringify(owner).includes(foreignTeam));
  assert.ok(!JSON.stringify(owner).includes(foreignProject)); assert.ok(!JSON.stringify(owner).includes(foreignEnv));
  assert.ok(owner.projects.every(project => project.environments.every(env => env.permissionSource === 'owner' && Object.values(env.permissions).every(Boolean))));
  assert.deepEqual(owner.projects.find(project => project.id === f.project.id)!.grants, [{ userId: f.sender.id, receive: 1, send: 0, externalShare: 1 }]);
  const denied = (await store.catalog(f.other.id, f.orgId)).projects[0]!.environments.find(env => env.id === defaults.id)!;
  assert.deepEqual(denied.permissions, { receive: false, send: false, externalShare: false });
  await assert.rejects(store.catalog(f.sender.id, foreignOrg), /organization_not_found/);
  await f.db.run('UPDATE users SET disabled=1 WHERE id=$1', f.owner.id);
  await assert.rejects(store.catalog(f.owner.id, f.orgId));
});

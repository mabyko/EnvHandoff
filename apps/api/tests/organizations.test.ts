import { testDatabase } from './database.ts';
import type { Database } from '../src/database.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuthApi } from '../src/auth.ts';
import { Organizations, githubAccount } from '../src/organizations.ts';
const time = 1800000000000, week = 7 * 24 * 60 * 60000;
const config = { development: true, apiOrigin: 'http://localhost:3001', webOrigin: 'http://localhost:5173', clientId: 'testClient', clientSecret: 'testSecret' };
async function user(db: Database, id: number) {
  const value = { userId: randomUUID(), id: String(id), login: 'user' + id, token: randomBytes(32).toString('base64url'), csrf: randomBytes(32).toString('base64url') };
  await db.run("INSERT INTO users (id,github_id,login) VALUES ($1,$2,$3)", value.userId, value.id, value.login);
  await db.run("INSERT INTO sessions VALUES ($1,$2,$3,$4,$5)", createHash('sha256').update(value.token).digest('base64url'), value.userId, value.csrf, time, time);
  return value;
}
async function bootstrap(store: Organizations, owner: Awaited<ReturnType<typeof user>>, name = 'Test organization') {
  const invite = (await store.issueOwner(owner));
  const organization = (await store.accept(owner.userId, invite.token, name));
  const detail = (await store.detail(owner.userId, organization.id));
  return { ...organization, token: invite.token, teamId: detail.teams[0]!.id as string };
}
function request(path: string, account?: Awaited<ReturnType<typeof user>>, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(config.apiOrigin + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      origin: config.webOrigin, ...(account ? { cookie: 'envhandoff-dev-session=' + account.token, 'x-csrf-token': account.csrf } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers,
    }, body: body === undefined ? undefined : JSON.stringify(body) });
}
test('environment create and rename enforce the encrypted bundle metadata limit', async (t) => {
  const db = (await testDatabase(t)).connect();
  try {
    const api = new AuthApi(db, config, fetch, () => time), store = new Organizations(db, () => time), owner = await user(db, 1);
    const org = await bootstrap(store, owner), project = await store.createProject(owner.userId, org.id, 'p'.repeat(80), [org.teamId]);
    const path = '/organizations/' + org.id;
    const environment = await store.createEnvironment(owner.userId, org.id, project.id, 'e'.repeat(48));
    assert.equal((await api.handle(request(path + '/projects/' + project.id + '/environments', owner, { name: 'e'.repeat(49) }))).status, 400);
    assert.equal((await api.handle(request(path + '/environments/' + environment.id + '/rename', owner, { name: 'e'.repeat(49) }))).status, 400);
    await db.run('UPDATE environments SET name=$1 WHERE id=$2', 'legacy'.repeat(10), environment.id);
    assert.equal((await api.handle(request(path + '/environments/' + environment.id + '/rename', owner, { name: 'production' }))).status, 200);
  } finally { await db.close(); }
});
test('opening invitation is account-bound and idempotent across two DB connections and restart', async (t) => {
  const testDb = await testDatabase(t);
  let db = testDb.connect();
  try {
    new AuthApi(db, config, fetch, () => time);
    let store = new Organizations(db, () => time);
    const owner = (await user(db, 1)), other = (await user(db, 2)), invite = (await store.issueOwner(owner));
    assert.equal((await store.list(owner.userId)).length, 0);
    await assert.rejects(async () => (await store.accept(other.userId, invite.token, 'wrong')), /wrong_github_account/);
    await assert.rejects(async () => (await store.accept(owner.userId, invite.token, '  ')), /invalid_name/);
    assert.equal((await db.get("SELECT count(*) AS n FROM organizations"))!.n, 0);
    const org = (await store.accept(owner.userId, invite.token, 'Our team'));
    const connection = testDb.connect();
    try {
      assert.deepEqual((await new Organizations(connection, () => time).accept(owner.userId, invite.token, 'different name')), org);
    }
    finally {
      await connection.close();
    }
    assert.equal((await db.get("SELECT count(*) AS n FROM organizations"))!.n, 1);
    assert.equal((await db.get("SELECT count(*) AS n FROM teams"))!.n, 1);
    assert.equal((await db.get("SELECT count(*) AS n FROM team_members"))!.n, 1);
    assert.equal((await db.get("SELECT count(*) AS n FROM memberships"))!.n, 1);
    assert.ok(!JSON.stringify((await db.all("SELECT * FROM invitations"))).includes(invite.token));
    await db.close();
    db = testDb.connect();
    store = new Organizations(db, () => time);
    assert.deepEqual((await store.accept(owner.userId, invite.token)), org);
    await assert.rejects(async () => (await store.detail(other.userId, org.id)), /organization_not_found/);
    await assert.rejects(async () => (await store.removeMember(owner.userId, org.id, owner.userId)), /last_owner/);
    const cancelled = (await store.issueOwner(other));
    await store.cancelOpening(cancelled.id);
    await assert.rejects(async () => (await store.accept(other.userId, cancelled.token, 'No organization')), /invitation_unavailable/);
    await assert.rejects(async () => (await store.cancelOpening(invite.id)), /already_accepted/);
  }
  finally {
    await db.close();
  }
});
test('member invitations enforce team/org boundaries, expiry, cancellation and current Owner authority', async (t) => {
  const testDb = await testDatabase(t);
  let now = time;
  const db = testDb.connect();
  try {
    new AuthApi(db, config, fetch, () => now);
    const store = new Organizations(db, () => now), owner = (await user(db, 1)), member = (await user(db, 2)), outsider = (await user(db, 3));
    const a = (await bootstrap(store, owner)), b = (await bootstrap(store, outsider));
    await assert.rejects(async () => (await store.issueMember(owner.userId, a.id, b.teamId, member)), /invalid_team/);
    const first = (await store.issueMember(owner.userId, a.id, a.teamId, member));
    await assert.rejects(async () => (await store.accept(outsider.userId, first.token)), /wrong_github_account/);
    await store.accept(member.userId, first.token);
    assert.equal((await store.detail(member.userId, a.id)).role, 'member');
    assert.equal((await store.detail(member.userId, a.id)).invitations.length, 0);
    await assert.rejects(async () => (await store.issueMember(member.userId, a.id, a.teamId, outsider)), /owner_required/);
    await assert.rejects(async () => (await store.removeMember(member.userId, a.id, owner.userId)), /owner_required/);
    await assert.rejects(async () => (await store.detail(member.userId, b.id)), /organization_not_found/);
    const cancelled = (await store.issueMember(owner.userId, a.id, a.teamId, outsider));
    await store.cancel(owner.userId, a.id, cancelled.id);
    await assert.rejects(async () => (await store.accept(outsider.userId, cancelled.token)), /invitation_unavailable/);
    const expired = (await store.issueMember(owner.userId, a.id, a.teamId, outsider));
    now += week;
    await assert.rejects(async () => (await store.accept(outsider.userId, expired.token)), /invitation_unavailable/);
    const demoted = (await store.issueMember(owner.userId, a.id, a.teamId, outsider));
    await db.run("UPDATE memberships SET role='member' WHERE org_id=$1 AND user_id=$2", a.id, owner.userId);
    await assert.rejects(async () => (await store.accept(outsider.userId, demoted.token)), /invitation_unavailable/);
    await db.run("UPDATE memberships SET role='owner' WHERE org_id=$1 AND user_id=$2", a.id, owner.userId);
    await assert.rejects(async () => (await store.accept(outsider.userId, demoted.token)), /invitation_unavailable/);
    await store.removeMember(owner.userId, a.id, member.userId);
    await assert.rejects(async () => (await store.accept(member.userId, first.token)), /invitation_unavailable/);
    const replacement = (await store.issueMember(owner.userId, a.id, a.teamId, member));
    await store.accept(member.userId, replacement.token);
    await db.run("UPDATE organizations SET active=0 WHERE id=$1", a.id);
    assert.equal((await store.list(member.userId))[0]!.active, 0);
    await assert.rejects(async () => (await store.detail(member.userId, a.id)), /organization_inactive/);
    await assert.rejects(async () => (await store.issueMember(owner.userId, a.id, a.teamId, outsider)), /organization_inactive/);
  }
  finally {
    await db.close();
  }
});
test('20-member cap, duplicate joins, disabled issuers and immutable GitHub identity', async (t) => {
  const testDb = await testDatabase(t);
  let now = time;
  const db = testDb.connect();
  try {
    const api = new AuthApi(db, config, fetch, () => now), store = new Organizations(db, () => now), owner = (await user(db, 1));
    const org = (await bootstrap(store, owner));
    for (let i = 2; i <= 20; i++) {
      const member = (await user(db, i));
      await store.accept(member.userId, (await store.issueMember(owner.userId, org.id, org.teamId, member)).token);
    }
    const extra = (await user(db, 21)), pending = (await store.issueMember(owner.userId, org.id, org.teamId, extra));
    await assert.rejects(async () => (await store.accept(extra.userId, pending.token)), /member_limit/);
    now += 10 * 60000;
    const again = (await store.issueMember(owner.userId, org.id, org.teamId, owner));
    assert.equal((await store.accept(owner.userId, again.token)).role, 'owner');
    const removed = (await db.get("SELECT user_id FROM memberships WHERE org_id=$1 AND role='member' LIMIT 1", org.id))!.user_id as string;
    await store.removeMember(owner.userId, org.id, removed);
    await db.run("UPDATE users SET login=$1 WHERE id=$2", 'renamed', extra.userId);
    assert.equal((await store.accept(extra.userId, pending.token)).role, 'member');
    const future = (await store.issueMember(owner.userId, org.id, org.teamId, extra));
    await api.disableUser(owner.userId);
    await assert.rejects(async () => (await store.preview(extra.userId, future.token)), /invitation_unavailable/);
    await assert.rejects(async () => (await store.list(owner.userId)), /session_expired/);
  }
  finally {
    await db.close();
  }
});
test('HTTP requires live session, Origin, CSRF, bounded JSON and rejects privilege fields; no public org creation', async (t) => {
  const testDb = await testDatabase(t);
  const db = testDb.connect();
  try {
    const api = new AuthApi(db, config, fetch, () => time), store = new Organizations(db, () => time), owner = (await user(db, 1));
    const invite = (await store.issueOwner(owner));
    assert.equal((await api.handle(request('/organizations'))).status, 401);
    assert.equal((await api.handle(request('/organizations', owner, { name: 'Open signup' }))).status, 403);
    assert.equal((await api.handle(request('/organizations/invitations/accept', owner, { token: invite.token, name: 'A' }, { origin: 'https://evil.example' }))).status, 403);
    assert.equal((await api.handle(request('/organizations/invitations/accept', owner, { token: invite.token, name: 'A' }, { 'x-csrf-token': '' }))).status, 403);
    assert.equal((await api.handle(request('/organizations/invitations/accept', owner, { token: invite.token, name: 'A', role: 'owner' }))).status, 400);
    assert.equal((await api.handle(request('/organizations/invitations/accept', owner, { token: invite.token, name: 'x'.repeat(9000) }))).status, 413);
    assert.equal((await api.handle(request('/organizations/invitations/accept', owner, [], {}))).status, 400);
    const accepted = await api.handle(request('/organizations/invitations/accept', owner, { token: invite.token, name: 'A' }));
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('access-control-allow-origin'), config.webOrigin);
    assert.equal(accepted.headers.get('cache-control'), 'no-store');
    const org = await accepted.json();
    assert.equal((await api.handle(request('/organizations/' + org.id, owner))).status, 200);
    const outsider = (await user(db, 2));
    assert.equal((await api.handle(request('/organizations/' + org.id, outsider))).status, 404);
    await api.disableUser(owner.userId);
    assert.equal((await api.handle(request('/organizations/' + org.id, owner))).status, 401);
  }
  finally {
    await db.close();
  }
});
test('two simulated accounts complete member onboarding over HTTP and cannot bypass Owner controls', async (t) => {
  const testDb = await testDatabase(t);
  const db = testDb.connect();
  let lookups = 0;
  const provider: typeof fetch = async (url) => {
    lookups++;
    assert.equal(url, 'https://api.github.com/users/user2');
    return Response.json({ id: 2, login: 'user2', type: 'User' });
  };
  try {
    const api = new AuthApi(db, config, provider, () => time), store = new Organizations(db, () => time);
    const owner = (await user(db, 1)), member = (await user(db, 2)), peer = (await user(db, 3));
    const org = (await bootstrap(store, owner)), base = '/organizations/' + org.id;
    const issued = await api.handle(request(base + '/invitations', owner, { login: member.login, teamId: org.teamId }));
    assert.equal(issued.status, 200);
    const invite = await issued.json();
    const wrongAccount = await api.handle(request('/organizations/invitations/accept', peer, { token: invite.token }));
    assert.equal(wrongAccount.status, 403);
    assert.equal((await wrongAccount.json()).error, 'wrong_github_account');
    const preview = await api.handle(request('/organizations/invitations/preview', member, { token: invite.token }));
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).kind, 'member');
    for (let retry = 0; retry < 2; retry++) {
      const accepted = await api.handle(request('/organizations/invitations/accept', member, { token: invite.token }));
      assert.equal(accepted.status, 200);
      assert.equal((await accepted.json()).role, 'member');
    }
    const peerInvite = (await store.issueMember(owner.userId, org.id, org.teamId, peer));
    await store.accept(peer.userId, peerInvite.token);
    const pending = (await store.issueMember(owner.userId, org.id, org.teamId, peer));
    const memberView = await api.handle(request(base, member));
    assert.equal(memberView.status, 200);
    const detail = await memberView.json();
    assert.equal(detail.role, 'member');
    assert.equal(detail.members.length, 3);
    assert.deepEqual(detail.invitations, []);
    assert.equal(detail.teams[0].id, org.teamId);
    const before = JSON.stringify((await db.all("SELECT * FROM memberships")));
    for (const [path, body] of [
      [base + '/invitations', { login: 'user2', teamId: org.teamId }],
      [base + '/invitations/' + pending.id + '/cancel', {}],
      [base + '/members/' + peer.userId + '/remove', {}],
      [base + '/members/' + owner.userId + '/remove', {}],
    ] as const) {
      const denied = await api.handle(request(path, member, body));
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error, 'owner_required');
    }
    assert.equal(lookups, 1, 'Unauthorized invites must not even call GitHub');
    assert.equal(JSON.stringify((await db.all("SELECT * FROM memberships"))), before);
    assert.equal((await db.get("SELECT status FROM invitations WHERE id=$1", pending.id))!.status, 'pending');
    assert.equal((await api.handle(request(base + '/invitations/' + pending.id + '/cancel', owner, {}))).status, 200);
    assert.equal((await api.handle(request(base + '/members/' + member.userId + '/remove', owner, {}))).status, 200);
    assert.equal((await api.handle(request(base, member))).status, 404);
    assert.equal((await api.handle(request('/organizations/invitations/accept', member, { token: invite.token }))).status, 410);
    assert.equal((await api.handle(request(base + '/members/' + peer.userId + '/remove', peer, {}))).status, 200);
    assert.equal((await api.handle(request(base, peer))).status, 404);
    assert.equal((await store.detail(owner.userId, org.id)).members.length, 1);
  }
  finally {
    await db.close();
  }
});
test('projects use default team metadata access with automatic Owner permissions and default-deny Member permissions', async (t) => {
  const testDb = await testDatabase(t);
  const db = testDb.connect();
  try {
    new AuthApi(db, config, fetch, () => time);
    const store = new Organizations(db, () => time), owner = (await user(db, 1)), member = (await user(db, 2));
    const org = (await bootstrap(store, owner));
    await store.accept(member.userId, (await store.issueMember(owner.userId, org.id, org.teamId, member)).token);
    const project = (await store.createProject(owner.userId, org.id, 'API')), env = (await store.createEnvironment(owner.userId, org.id, project.id, 'production'));
    assert.deepEqual((await store.catalog(owner.userId, org.id)).projects[0]!.teamIds, [org.teamId]);
    for (const action of ['receive', 'send', 'externalShare'] as const) {
      await store.requireFilePermission(owner.userId, org.id, env.id, action);
      await assert.rejects(store.requireFilePermission(member.userId, org.id, env.id, action), /file_permission_required/);
    }
    await assert.rejects(store.setPermissions(owner.userId, org.id, env.id, owner.userId, true, false, false), /owner_permissions_automatic/);
    await store.setPermissions(owner.userId, org.id, env.id, member.userId, false, true, false);
    await store.requireFilePermission(member.userId, org.id, env.id, 'send');
    assert.deepEqual((await store.catalog(member.userId, org.id)).projects[0]!.environments[0]!.grants, []);
    await store.setPermissions(owner.userId, org.id, env.id, member.userId, false, false, true);
    await store.requireFilePermission(member.userId, org.id, env.id, 'externalShare');
    await assert.rejects(async () => (await store.requireFilePermission(member.userId, org.id, env.id, 'send')), /file_permission_required/);
    await assert.rejects(async () => (await store.setPermissions(owner.userId, org.id, env.id, member.userId, 'false', true, false)), /invalid_permission/);
    await store.setTeamMember(owner.userId, org.id, org.teamId, owner.userId, false);
    assert.equal((await store.catalog(owner.userId, org.id)).projects.length, 1, 'Owner retains management metadata access');
    await store.requireFilePermission(owner.userId, org.id, env.id, 'receive');
  }
  finally {
    await db.close();
  }
});
test('team paths combine within one organization; new teams add no project access and rejoining restores no grants', async (t) => {
  const testDb = await testDatabase(t);
  const db = testDb.connect();
  try {
    new AuthApi(db, config, fetch, () => time);
    const store = new Organizations(db, () => time), owner = (await user(db, 1)), member = (await user(db, 2)), outsider = (await user(db, 3));
    const org = (await bootstrap(store, owner)), foreign = (await bootstrap(store, outsider));
    const project = (await store.createProject(owner.userId, org.id, 'API')), env = (await store.createEnvironment(owner.userId, org.id, project.id, 'dev'));
    const team = (await store.createTeam(owner.userId, org.id, 'Backend'));
    await store.accept(member.userId, (await store.issueMember(owner.userId, org.id, team.id, member)).token);
    assert.equal((await store.catalog(member.userId, org.id)).projects.length, 0);
    await store.setPermissions(owner.userId, org.id, env.id, member.userId, true, false, false);
    await assert.rejects(async () => (await store.requireFilePermission(member.userId, org.id, env.id, 'receive')), /project_not_found/);
    await store.setProjectTeams(owner.userId, org.id, project.id, [org.teamId, team.id]);
    await store.setTeamMember(owner.userId, org.id, org.teamId, member.userId, true);
    await store.setTeamMember(owner.userId, org.id, team.id, member.userId, false);
    await store.requireFilePermission(member.userId, org.id, env.id, 'receive');
    await store.setTeamMember(owner.userId, org.id, org.teamId, member.userId, false);
    assert.equal((await store.catalog(member.userId, org.id)).projects.length, 0);
    await assert.rejects(async () => (await store.requireFilePermission(member.userId, org.id, env.id, 'receive')), /project_not_found/);
    await assert.rejects(async () => (await store.setProjectTeams(owner.userId, org.id, project.id, [foreign.teamId])), /invalid_team/);
    await assert.rejects(async () => (await store.setTeamMember(owner.userId, org.id, foreign.teamId, member.userId, true)), /team_not_found/);
    await assert.rejects(async () => (await store.setPermissions(owner.userId, org.id, env.id, outsider.userId, true, true, true)), /member_not_found/);
    const foreignProject = (await store.createProject(outsider.userId, foreign.id, 'Foreign')), foreignEnv = (await store.createEnvironment(outsider.userId, foreign.id, foreignProject.id, 'dev'));
    await assert.rejects(async () => (await store.setPermissions(owner.userId, org.id, foreignEnv.id, member.userId, true, true, true)), /environment_not_found/);
    await store.removeMember(owner.userId, org.id, member.userId);
    await store.accept(member.userId, (await store.issueMember(owner.userId, org.id, org.teamId, member)).token);
    await assert.rejects(async () => (await store.requireFilePermission(member.userId, org.id, env.id, 'receive')), /file_permission_required/);
    assert.equal((await db.get("SELECT count(*) AS n FROM environment_permissions WHERE user_id=$1", member.userId))!.n, 0);
  }
  finally {
    await db.close();
  }
});
test('catalog mutations require Owner at the HTTP boundary, validate names/IDs and deny inactive accounts and organizations', async (t) => {
  const testDb = await testDatabase(t);
  const db = testDb.connect();
  try {
    const api = new AuthApi(db, config, fetch, () => time), store = new Organizations(db, () => time), owner = (await user(db, 1)), member = (await user(db, 2));
    const org = (await bootstrap(store, owner)), base = '/organizations/' + org.id;
    await store.accept(member.userId, (await store.issueMember(owner.userId, org.id, org.teamId, member)).token);
    const create = await api.handle(request(base + '/projects', owner, { name: 'API' }));
    assert.equal(create.status, 200);
    const project = await create.json();
    const createdEnv = await api.handle(request(base + '/projects/' + project.id + '/environments', owner, { name: 'dev' }));
    assert.equal(createdEnv.status, 200);
    const env = await createdEnv.json();
    for (const [path, body] of [
      ['/teams', { name: 'New' }], ['/projects', { name: 'New' }],
      ['/projects/' + project.id + '/environments', { name: 'New' }],
      ['/projects/' + project.id + '/teams', { teamIds: [] }],
      ['/teams/' + org.teamId + '/members', { userId: owner.userId, included: false }],
      ['/environments/' + env.id + '/permissions', { userId: member.userId, receive: true, send: true, externalShare: true }],
      ['/environments/' + env.id + '/rename', { name: 'New' }],
      ['/projects/' + project.id + '/remove', {}],
    ] as const)
      assert.equal((await api.handle(request(base + path, member, body))).status, 403);
    assert.equal((await api.handle(request(base + '/projects', owner, { name: 'API' }))).status, 409);
    assert.equal((await api.handle(request(base + '/teams', owner, { name: '\u0000' }))).status, 400);
    assert.equal((await api.handle(request(base + '/projects/' + project.id + '/teams', owner, { teamIds: [org.teamId, org.teamId] }))).status, 400);
    assert.deepEqual((await store.catalog(owner.userId, org.id)).projects[0]!.teamIds, [org.teamId]);
    assert.equal((await api.handle(request(base + '/catalog', member))).status, 200);
    await db.run("UPDATE organizations SET active=0 WHERE id=$1", org.id);
    assert.equal((await api.handle(request(base + '/catalog', member))).status, 403);
    assert.equal((await api.handle(request(base + '/projects', owner, { name: 'New' }))).status, 403);
    await db.run("UPDATE organizations SET active=1 WHERE id=$1", org.id);
    await api.disableUser(member.userId);
    assert.equal((await api.handle(request(base + '/catalog', member))).status, 401);
  }
  finally {
    await db.close();
  }
});
test('rename and deletion keep scope boundaries, preserve the default team and remove dependent permissions', async (t) => {
  const testDb = await testDatabase(t);
  const db = testDb.connect();
  try {
    new AuthApi(db, config, fetch, () => time);
    const store = new Organizations(db, () => time), owner = (await user(db, 1)), target = (await user(db, 2));
    const org = (await bootstrap(store, owner)), other = (await bootstrap(store, owner, 'Other'));
    const project = (await store.createProject(owner.userId, org.id, 'API')), env = (await store.createEnvironment(owner.userId, org.id, project.id, 'dev'));
    const otherProject = (await store.createProject(owner.userId, other.id, 'API'));
    const member = await user(db, 3);
    await store.accept(member.userId, (await store.issueMember(owner.userId, org.id, org.teamId, member)).token);
    const team = (await store.createTeam(owner.userId, org.id, 'Backend')), invite = (await store.issueMember(owner.userId, org.id, team.id, target));
    await store.setProjectTeams(owner.userId, org.id, project.id, [org.teamId, team.id]);
    await store.setPermissions(owner.userId, org.id, env.id, member.userId, true, true, true);
    await store.rename(owner.userId, org.id, 'projects', project.id, 'Renamed');
    await store.rename(owner.userId, org.id, 'environments', env.id, 'production');
    await store.rename(owner.userId, org.id, 'teams', team.id, 'Platform');
    assert.equal((await store.catalog(owner.userId, org.id)).projects[0]!.name, 'Renamed');
    await assert.rejects(async () => (await store.rename(owner.userId, org.id, 'projects', otherProject.id, 'Bad')), /item_not_found/);
    await assert.rejects(async () => (await store.remove(owner.userId, org.id, 'projects', otherProject.id)), /project_not_found/);
    await assert.rejects(async () => (await store.remove(owner.userId, org.id, 'teams', org.teamId)), /default_team_required/);
    await store.remove(owner.userId, org.id, 'teams', team.id);
    await assert.rejects(async () => (await store.accept(target.userId, invite.token)), /invitation_unavailable/);
    assert.deepEqual((await store.catalog(owner.userId, org.id)).projects[0]!.teamIds, [org.teamId]);
    await store.remove(owner.userId, org.id, 'environments', env.id);
    assert.equal((await db.get("SELECT count(*) AS n FROM environment_permissions"))!.n, 0);
    const newEnv = (await store.createEnvironment(owner.userId, org.id, project.id, 'production'));
    assert.notEqual(newEnv.id, env.id);
    await assert.rejects(async () => (await store.requireFilePermission(member.userId, org.id, newEnv.id, 'send')), /file_permission_required/);
    await store.setPermissions(owner.userId, org.id, newEnv.id, member.userId, true, true, true);
    await store.remove(owner.userId, org.id, 'projects', project.id);
    assert.equal((await db.get("SELECT count(*) AS n FROM environment_permissions"))!.n, 0);
    assert.equal((await db.get("SELECT count(*) AS n FROM environments"))!.n, 0);
    assert.equal((await store.catalog(owner.userId, other.id)).projects.length, 1);
  }
  finally {
    await db.close();
  }
});
test('PostgreSQL migration is idempotent and preserves existing teams and memberships', async (t) => {
  const testDb = await testDatabase(t), db = testDb.connect();
  try {
    const store = new Organizations(db, () => time), owner = (await user(db, 1));
    const org = (await bootstrap(store, owner));
    await store.createTeam(owner.userId, org.id, 'Second');
    await db.migrate();
    const reopened = new Organizations(db, () => time);
    await reopened.createProject(owner.userId, org.id, 'API');
    assert.deepEqual((await reopened.catalog(owner.userId, org.id)).projects[0]!.teamIds, [org.teamId]);
    assert.equal((await db.get("SELECT count(*) AS n FROM teams WHERE is_default=1"))!.n, 1);
    assert.equal((await db.get("SELECT count(*) AS n FROM team_members"))!.n, 1);
  }
  finally {
    await db.close();
  }
});
test('GitHub lookup uses public identity and rechecks session/Owner after network wait', async (t) => {
  const testDb = await testDatabase(t);
  const db = testDb.connect();
  try {
    let duringLookup = async () => { };
    const provider: typeof fetch = async (url, init) => {
      assert.equal(url, 'https://api.github.com/users/user2');
      assert.equal(new Headers(init?.headers).has('authorization'), false);
      await duringLookup();
      return Response.json({ id: 2, login: 'user2', type: 'User' });
    };
    const api = new AuthApi(db, config, provider, () => time), store = new Organizations(db, () => time), owner = (await user(db, 1)), member = (await user(db, 2));
    const org = (await bootstrap(store, owner));
    const path = '/organizations/' + org.id + '/invitations', body = { login: member.login, teamId: org.teamId };
    const issued = await api.handle(request(path, owner, body));
    assert.equal(issued.status, 200);
    const invite = await issued.json();
    assert.ok(invite.url.startsWith(config.webOrigin + '/pro#invite='));
    assert.equal((await store.accept(member.userId, invite.token)).role, 'member');
    duringLookup = async () => { await db.run("UPDATE memberships SET role='member' WHERE user_id=$1", owner.userId); };
    assert.equal((await api.handle(request(path, owner, body))).status, 403);
    await db.run("UPDATE memberships SET role='owner' WHERE user_id=$1", owner.userId);
    duringLookup = async () => { await api.disableUser(owner.userId); };
    assert.equal((await api.handle(request(path, owner, body))).status, 401);
    await assert.rejects(githubAccount('../users', provider), /invalid_github_login/);
    await assert.rejects(githubAccount('org', async () => Response.json({ id: 3, login: 'org', type: 'Organization' })), /invalid_github_account/);
  }
  finally {
    await db.close();
  }
});

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { fixture, config } from './request-fixture.ts'
import { Deletions } from '../src/deletions.ts'

type Fixture = Awaited<ReturnType<typeof fixture>>
function call(f: Fixture, user: Fixture['owner'], path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  return f.api.handle(new Request(config.apiOrigin + '/organizations/' + f.orgId + path, {
    method: body ? 'POST' : 'GET', headers: { origin: config.webOrigin, cookie: 'envhandoff-dev-session=' + user.token, 'x-csrf-token': user.csrf,
      ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined,
  }))
}
const flags = (receive: boolean, send: boolean, externalShare: boolean) => ({ receive, send, externalShare })

test('Owner automatically has all file permissions without a team path or grants; Member defaults deny', async t => {
  const f = await fixture(t)
  await f.organizations.setProjectTeams(f.owner.id, f.orgId, f.project.id, [])
  const env = await f.organizations.createEnvironment(f.owner.id, f.orgId, f.project.id, 'production')
  for (const action of ['receive', 'send', 'externalShare'] as const) await f.organizations.requireFilePermission(f.owner.id, f.orgId, env.id, action)
  assert.deepEqual((await f.organizations.catalog(f.owner.id, f.orgId)).projects[0]!.environments.find(e => e.id === env.id)!.permissions, flags(true, true, true))
  assert.equal((await call(f, f.owner, '/projects/' + f.project.id + '/permissions', { userId: f.owner.id, ...flags(false, false, false) })).status, 409)
  assert.equal((await call(f, f.owner, '/environments/' + env.id + '/permissions', { userId: f.owner.id, inherit: true })).status, 409)
  await f.organizations.setProjectTeams(f.owner.id, f.orgId, f.project.id, [f.teamId])
  for (const action of ['receive', 'send', 'externalShare'] as const) await assert.rejects(f.organizations.requireFilePermission(f.other.id, f.orgId, env.id, action), /file_permission_required/)
  await f.db.run('UPDATE users SET disabled=1 WHERE id=$1', f.owner.id)
  assert.equal((await f.db.get('SELECT count(*) AS n FROM effective_file_permissions WHERE user_id=$1', f.owner.id))!.n, 0)
})

test('project permissions inherit into new environments, explicit deny overrides allow, and reset restores inheritance over HTTP', async t => {
  const f = await fixture(t), projectPath = '/projects/' + f.project.id + '/permissions', envPath = '/environments/' + f.environment.id + '/permissions'
  const grant = { userId: f.receiver.id, ...flags(true, false, true) }
  assert.equal((await call(f, f.receiver, projectPath, grant)).status, 403)
  assert.equal((await call(f, f.owner, projectPath, grant, { 'x-csrf-token': 'wrong' })).status, 403)
  assert.equal((await call(f, f.owner, projectPath, grant, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await call(f, f.owner, projectPath, { ...grant, send: 'true' })).status, 400)
  assert.equal((await call(f, f.owner, projectPath, grant)).status, 200)
  assert.equal((await call(f, f.owner, envPath, { userId: f.receiver.id, inherit: true, receive: true })).status, 400)
  assert.equal((await call(f, f.owner, envPath, { userId: f.receiver.id, inherit: false })).status, 400)
  assert.equal((await call(f, f.owner, envPath, { userId: f.receiver.id, inherit: true })).status, 200)
  const prod = await f.organizations.createEnvironment(f.owner.id, f.orgId, f.project.id, 'production')
  let catalog = await f.organizations.catalog(f.receiver.id, f.orgId)
  for (const env of catalog.projects[0]!.environments) {
    assert.deepEqual(env.permissions, flags(true, false, true)); assert.equal(env.permissionSource, 'project'); assert.deepEqual(env.grants, [])
  }
  assert.deepEqual(catalog.projects[0]!.grants, [])
  const prodPath = '/environments/' + prod.id + '/permissions'
  assert.equal((await call(f, f.owner, prodPath, { userId: f.receiver.id, ...flags(false, false, false) })).status, 200)
  assert.equal((await call(f, f.owner, projectPath, { userId: f.receiver.id, ...flags(true, true, true) })).status, 200)
  catalog = await f.organizations.catalog(f.receiver.id, f.orgId)
  assert.deepEqual(catalog.projects[0]!.environments.find(e => e.id === prod.id)!.permissions, flags(false, false, false))
  assert.equal(catalog.projects[0]!.environments.find(e => e.id === prod.id)!.permissionSource, 'environment')
  assert.equal((await call(f, f.owner, prodPath, { userId: f.receiver.id, inherit: true })).status, 200)
  assert.deepEqual((await f.organizations.catalog(f.receiver.id, f.orgId)).projects[0]!.environments.find(e => e.id === prod.id)!.permissions, flags(true, true, true))
})

test('project and override revocation close affected requests and shares atomically without reviving them on regrant', async t => {
  const f = await fixture(t)
  await f.organizations.setProjectPermissions(f.owner.id, f.orgId, f.project.id, f.receiver.id, true, false, true)
  await f.organizations.inheritPermissions(f.owner.id, f.orgId, f.environment.id, f.receiver.id)
  const inherited = await f.create()
  const other = await f.organizations.createEnvironment(f.owner.id, f.orgId, f.project.id, 'override')
  await f.organizations.setPermissions(f.owner.id, f.orgId, other.id, f.receiver.id, true, false, true)
  await f.organizations.setPermissions(f.owner.id, f.orgId, other.id, f.sender.id, false, true, false)
  const overridden = await f.ok(f.receiver, '', { ...f.input(), environmentId: other.id })
  const shareId = randomUUID()
  assert.equal((await call(f, f.receiver, '/shares', { operationId: shareId, environmentId: f.environment.id, size: 40, digest: randomBytes(32).toString('base64url'), tokenHash: randomBytes(32).toString('base64url'), retentionDays: 1 })).status, 200)
  await f.organizations.setProjectPermissions(f.owner.id, f.orgId, f.project.id, f.receiver.id, false, false, false)
  assert.equal((await f.db.get('SELECT status FROM file_requests WHERE id=$1', inherited.id))!.status, 'cancelled')
  assert.equal((await f.db.get('SELECT status FROM file_requests WHERE id=$1', overridden.id))!.status, 'pending')
  assert.ok((await f.db.get('SELECT ended_at FROM external_shares WHERE id=$1', shareId))!.ended_at)
  await f.organizations.inheritPermissions(f.owner.id, f.orgId, other.id, f.receiver.id)
  assert.equal((await f.db.get('SELECT status FROM file_requests WHERE id=$1', overridden.id))!.status, 'cancelled')
  await f.organizations.setProjectPermissions(f.owner.id, f.orgId, f.project.id, f.receiver.id, true, false, true)
  assert.equal((await f.db.get('SELECT status FROM file_requests WHERE id=$1', inherited.id))!.status, 'cancelled')
  assert.ok((await f.db.get('SELECT ended_at FROM external_shares WHERE id=$1', shareId))!.ended_at)
})

test('migration preserves legacy member permissions including absent grants and compacts common values exactly once', async t => {
  const f = await fixture(t), prod = await f.organizations.createEnvironment(f.owner.id, f.orgId, f.project.id, 'production')
  await f.organizations.setPermissions(f.owner.id, f.orgId, prod.id, f.receiver.id, true, true, false)
  await f.organizations.setPermissions(f.owner.id, f.orgId, prod.id, f.sender.id, false, true, true)
  // Recreate the pre-010 schema and populated legacy view without changing the production migration API.
  await f.db.run('DROP VIEW effective_file_permissions')
  await f.db.run('DROP TABLE project_permissions')
  await f.db.run('DELETE FROM schema_migrations WHERE version=10')
  const legacy = (await readFile(new URL('../sql/003-requests.sql', import.meta.url), 'utf8')).split('-- Retain')[0]!
  await f.db.run(legacy)
  const before = new Map<string, unknown>()
  for (const user of [f.receiver, f.sender, f.other]) before.set(user.id, (await f.organizations.catalog(user.id, f.orgId)).projects[0]!.environments.map(e => e.permissions))
  await Promise.all([f.db.migrate(), f.storage.connect().migrate()])
  for (const user of [f.receiver, f.sender, f.other]) assert.deepEqual((await f.organizations.catalog(user.id, f.orgId)).projects[0]!.environments.map(e => e.permissions), before.get(user.id))
  assert.deepEqual(await f.db.get('SELECT receive,send,external_share FROM project_permissions WHERE project_id=$1 AND user_id=$2', f.project.id, f.receiver.id), { receive: 1, send: 1, external_share: 0 })
  assert.deepEqual(await f.db.get('SELECT receive,send,external_share FROM project_permissions WHERE project_id=$1 AND user_id=$2', f.project.id, f.other.id), { receive: 0, send: 0, external_share: 0 })
  assert.equal((await f.db.get('SELECT count(*) AS n FROM environment_permissions WHERE user_id=$1', f.receiver.id))!.n, 0)
  const next = await f.organizations.createEnvironment(f.owner.id, f.orgId, f.project.id, 'new')
  await f.organizations.requireFilePermission(f.receiver.id, f.orgId, next.id, 'receive')
  await assert.rejects(f.organizations.requireFilePermission(f.other.id, f.orgId, next.id, 'receive'), /file_permission_required/)
  // Re-running migrations must not fold away intentional overrides created later.
  await f.organizations.setPermissions(f.owner.id, f.orgId, next.id, f.receiver.id, true, true, false)
  await f.db.migrate()
  assert.ok(await f.db.get('SELECT 1 FROM environment_permissions WHERE environment_id=$1 AND user_id=$2', next.id, f.receiver.id))
})

test('project grants obey team and organization scope and disappear on departure, project deletion and account deletion', async t => {
  const f = await fixture(t)
  await f.organizations.setProjectPermissions(f.owner.id, f.orgId, f.project.id, f.receiver.id, true, true, true)
  await f.organizations.inheritPermissions(f.owner.id, f.orgId, f.environment.id, f.receiver.id)
  const extra = await f.organizations.createTeam(f.owner.id, f.orgId, 'Other path')
  await f.organizations.setTeamMember(f.owner.id, f.orgId, extra.id, f.receiver.id, true)
  await f.organizations.setProjectTeams(f.owner.id, f.orgId, f.project.id, [f.teamId, extra.id])
  await f.organizations.setTeamMember(f.owner.id, f.orgId, f.teamId, f.receiver.id, false)
  await f.organizations.requireFilePermission(f.receiver.id, f.orgId, f.environment.id, 'receive')
  await f.organizations.setProjectTeams(f.owner.id, f.orgId, f.project.id, [f.teamId])
  await assert.rejects(f.organizations.requireFilePermission(f.receiver.id, f.orgId, f.environment.id, 'receive'), /project_not_found/)
  const foreign = randomUUID(), foreignProject = randomUUID()
  await f.db.run("INSERT INTO organizations(id,name) VALUES($1,'Foreign')", foreign)
  await f.db.run("INSERT INTO projects VALUES($1,$2,'Foreign')", foreignProject, foreign)
  await assert.rejects(f.organizations.setProjectPermissions(f.owner.id, f.orgId, foreignProject, f.receiver.id, true, true, true), /project_not_found/)
  await f.organizations.removeMember(f.owner.id, f.orgId, f.receiver.id)
  assert.equal((await f.db.get('SELECT count(*) AS n FROM project_permissions WHERE user_id=$1', f.receiver.id))!.n, 0)
  await f.organizations.accept(f.receiver.id, (await f.organizations.issueMember(f.owner.id, f.orgId, f.teamId, { id: '2', login: 'receiver' })).token)
  await assert.rejects(f.organizations.requireFilePermission(f.receiver.id, f.orgId, f.environment.id, 'receive'), /file_permission_required/)
  await f.organizations.setProjectPermissions(f.owner.id, f.orgId, f.project.id, f.other.id, true, true, true)
  await f.organizations.remove(f.owner.id, f.orgId, 'projects', f.project.id)
  assert.equal((await f.db.get('SELECT count(*) AS n FROM project_permissions'))!.n, 0)
  const next = await f.organizations.createProject(f.owner.id, f.orgId, 'Next')
  await f.organizations.setProjectPermissions(f.owner.id, f.orgId, next.id, f.other.id, true, true, true)
  const ledger = new Deletions(f.localConfig.deletionLedgerPath)
  await ledger.record('user', f.other.id, f.now()); await ledger.sync(f.db, f.now())
  assert.equal((await f.db.get('SELECT count(*) AS n FROM project_permissions'))!.n, 0)
})

test('Owner promotion grants operations and demotion revokes automatic access without reviving old shares on repromotion', async t => {
  const f = await fixture(t), shareId = randomUUID()
  assert.equal((await call(f, f.owner, '/shares', { operationId: shareId, environmentId: f.environment.id, size: 40, digest: randomBytes(32).toString('base64url'), tokenHash: randomBytes(32).toString('base64url'), retentionDays: 1 })).status, 200)
  await f.organizations.setRole(f.owner.id, f.orgId, f.other.id, 'owner')
  await f.organizations.requireFilePermission(f.other.id, f.orgId, f.environment.id, 'externalShare')
  await f.organizations.setRole(f.other.id, f.orgId, f.owner.id, 'member')
  await assert.rejects(f.organizations.requireFilePermission(f.owner.id, f.orgId, f.environment.id, 'externalShare'), /file_permission_required/)
  assert.ok((await f.db.get('SELECT ended_at FROM external_shares WHERE id=$1', shareId))!.ended_at)
  await f.organizations.setRole(f.other.id, f.orgId, f.owner.id, 'owner')
  await f.organizations.requireFilePermission(f.owner.id, f.orgId, f.environment.id, 'externalShare')
  assert.ok((await f.db.get('SELECT ended_at FROM external_shares WHERE id=$1', shareId))!.ended_at)
})

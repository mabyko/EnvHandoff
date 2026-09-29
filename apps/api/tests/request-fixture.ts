import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { AuthApi } from '../src/auth.ts'
import { Deletions } from '../src/deletions.ts'
import { Organizations } from '../src/organizations.ts'
import { DeviceRegistry } from '../src/devices.ts'
import { answerDeviceChallenge, deviceIdentity } from '@envhandoff/protocol/device-proof'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testDatabase } from './database.ts'

export const config = { development: true, webOrigin: 'http://localhost:5173', apiOrigin: 'http://localhost:3001', clientId: 'test', clientSecret: 'test' }
export const DAY = 24 * 60 * 60_000
export async function fixture(t: TestContext) {
  const storage = await testDatabase(t), db = storage.connect()
  const fileStoragePath = await mkdtemp(join(tmpdir(), 'envhandoff-transfer-'))
  t.after(() => rm(fileStoragePath, { recursive: true, force: true }))
  const deletionLedgerPath = fileStoragePath + '-deletions'
  await Deletions.initialize(deletionLedgerPath)
  t.after(() => rm(deletionLedgerPath, { recursive: true, force: true }))
  const localConfig = { ...config, fileStoragePath, deletionLedgerPath }
  let now = 1_800_000_000_000
  const api = new AuthApi(db, localConfig, fetch, () => now), api2 = new AuthApi(storage.connect(), localConfig, fetch, () => now)
  const users = []
  for (const login of ['owner', 'receiver', 'sender', 'other']) {
    const id = randomUUID(), token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url')
    const hash = createHash('sha256').update(token).digest('base64url')
    await db.run('INSERT INTO users(id,github_id,login) VALUES ($1,$2,$3)', id, String(users.length + 1), login)
    await db.run('INSERT INTO sessions VALUES ($1,$2,$3,$4,$4)', hash, id, csrf, now)
    users.push({ id, token, csrf, hash })
  }
  const [owner, receiver, sender, other] = users as [typeof users[number], typeof users[number], typeof users[number], typeof users[number]]
  const orgId = randomUUID(), teamId = randomUUID()
  await db.run('INSERT INTO organizations(id,name) VALUES ($1,$2)', orgId, 'Request test')
  await db.run('INSERT INTO teams VALUES ($1,$2,$3,1)', teamId, orgId, 'Default')
  for (const user of users) {
    await db.run('INSERT INTO memberships VALUES ($1,$2,$3)', orgId, user.id, user === owner ? 'owner' : 'member')
    await db.run('INSERT INTO team_members VALUES ($1,$2)', teamId, user.id)
  }
  const organizations = new Organizations(db, () => now)
  const project = await organizations.createProject(owner.id, orgId, 'Project')
  const environment = await organizations.createEnvironment(owner.id, orgId, project.id, 'Development')
  for (const user of [receiver, sender, other]) await organizations.setPermissions(owner.id, orgId, environment.id, user.id, true, true, false)
  const encryption = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const identity = await deviceIdentity(receiver.id, randomUUID(), encryption.publicKey, signing.publicKey)
  const registry = new DeviceRegistry(db, () => now)
  const deviceSession = () => ({ userId: receiver.id, sessionId: receiver.hash, active: true, reauthenticatedAt: now })
  const wire = await registry.beginRegistration(deviceSession(), identity)
  await registry.complete(deviceSession(), wire.challenge.id, await answerDeviceChallenge(wire, wire.challenge, encryption, signing.privateKey, now))
  const path = '/organizations/' + orgId + '/requests'
  const call = (user: typeof owner, suffix = '', body?: Record<string, unknown>, selectedApi = api, headers: Record<string, string> = {}) => selectedApi.handle(new Request(config.apiOrigin + path + suffix, {
    method: body ? 'POST' : 'GET', headers: { origin: config.webOrigin, cookie: 'envhandoff-dev-session=' + user.token,
      ...(body ? { 'content-type': 'application/json', 'x-csrf-token': user.csrf } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined,
  }))
  const ok = async (user: typeof owner, suffix = '', body?: Record<string, unknown>, selectedApi = api) => {
    const response = await call(user, suffix, body, selectedApi), result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result)); return result
  }
  const input = () => ({ operationId: randomUUID(), environmentId: environment.id, senderId: sender.id, deviceId: identity.deviceId })
  const create = () => ok(receiver, '', input())
  return { storage, fileStoragePath, localConfig, db, api, api2, users, owner, receiver, sender, other, orgId, teamId, project, environment, organizations, identity, registry, deviceSession, encryption, signing, path, call, ok, input, create, now: () => now,
    advance: async (ms: number) => { now += ms; await db.run('UPDATE sessions SET created_at=$1,last_seen=$1', now) } }
}

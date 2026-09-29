import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { AuthApi } from '../src/auth.ts'
import { answerDeviceChallenge } from '@envhandoff/protocol/device-proof'
import { fixture, config, DAY } from './request-fixture.ts'

test('requests enforce organization, participant, independent permission and device boundaries with minimal closed receipts', async t => {
  const f = await fixture(t)
  const options = await f.ok(f.receiver, '/options?environmentId=' + f.environment.id)
  assert.deepEqual(options.senders.map((u: { id: string }) => u.id).sort(), [f.sender.id, f.other.id].sort())
  assert.equal((await f.call(f.owner, '', f.input())).status, 403) // Owner has no file rights.
  assert.equal((await f.call(f.receiver, '', { ...f.input(), deviceId: randomUUID() })).status, 403)
  assert.equal((await f.call(f.receiver, '', { ...f.input(), senderId: f.receiver.id })).status, 400)
  await f.db.run('UPDATE users SET disabled=1 WHERE id=$1', f.sender.id)
  assert.equal((await f.call(f.receiver, '', f.input())).status, 403)
  await f.db.run('UPDATE users SET disabled=0 WHERE id=$1', f.sender.id)
  const foreign = randomUUID()
  await f.db.run('INSERT INTO organizations(id,name) VALUES ($1,$2)', foreign, 'Foreign')
  const wrongOrg = await f.api.handle(new Request(config.apiOrigin + '/organizations/' + foreign + '/requests/options?environmentId=' + f.environment.id, { headers: { cookie: 'envhandoff-dev-session=' + f.receiver.token } }))
  assert.equal(wrongOrg.status, 404)
  const request = await f.create()
  assert.equal((await f.call(f.other, '/' + request.id)).status, 404)
  assert.equal((await f.ok(f.other)).requests.length, 0)
  assert.equal((await f.ok(f.owner)).requests[0].direction, 'managed')
  assert.equal((await f.call(f.owner, '/' + request.id + '/approve', { operationId: randomUUID() })).status, 403)
  assert.equal((await f.call(f.receiver, '/' + request.id + '/reject', { operationId: randomUUID() })).status, 403)
  await f.ok(f.owner, '/' + request.id + '/cancel', { operationId: randomUUID() })
  const closed = await f.ok(f.receiver, '/' + request.id)
  assert.deepEqual(Object.keys(closed).sort(), ['id','status','createdAt','expiresAt','direction'].sort())
  assert.equal(closed.status, 'cancelled')
})

test('request creation and transitions serialize across connections, retry identically, reject changed operation IDs and never revive', async t => {
  const f = await fixture(t), input = f.input()
  const [a, b] = await Promise.all([f.ok(f.receiver, '', input), f.ok(f.receiver, '', input, f.api2)])
  assert.deepEqual(a, b)
  assert.equal((await f.db.get('SELECT count(*) AS n FROM file_requests'))!.n, 1)
  assert.equal((await f.call(f.receiver, '', { ...input, senderId: f.other.id })).status, 409)
  const operation = { operationId: randomUUID() }
  const [approved, retried] = await Promise.all([f.ok(f.sender, '/' + a.id + '/approve', operation), f.ok(f.sender, '/' + a.id + '/approve', operation, f.api2)])
  assert.deepEqual(approved, retried)
  assert.equal((await f.call(f.sender, '/' + a.id + '/reject', operation)).status, 409)
  await f.ok(f.receiver, '/' + a.id + '/cancel', { operationId: randomUUID() })
  await f.ok(f.sender, '/' + a.id + '/approve', operation) // Original operation receipt only.
  assert.equal((await f.ok(f.sender, '/' + a.id)).status, 'cancelled')
  assert.equal((await f.call(f.sender, '/' + a.id + '/approve', { operationId: randomUUID() })).status, 409)
  const c = await f.create()
  const results = await Promise.all([f.call(f.sender, '/' + c.id + '/approve', { operationId: randomUUID() }), f.call(f.sender, '/' + c.id + '/reject', { operationId: randomUUID() }, f.api2)])
  assert.deepEqual(results.map(r => r.status).sort(), [200,409])
})

test('effective access loss cancels atomically; alternate team paths survive, regrant and rejoin never restore requests', async t => {
  const f = await fixture(t), a = await f.create()
  const extra = await f.organizations.createTeam(f.owner.id, f.orgId, 'Extra')
  await f.organizations.setTeamMember(f.owner.id, f.orgId, extra.id, f.receiver.id, true)
  await f.organizations.setProjectTeams(f.owner.id, f.orgId, f.project.id, [f.teamId,extra.id])
  await f.organizations.setTeamMember(f.owner.id, f.orgId, f.teamId, f.receiver.id, false)
  assert.equal((await f.ok(f.receiver, '/' + a.id)).status, 'pending')
  await f.organizations.setTeamMember(f.owner.id, f.orgId, extra.id, f.receiver.id, false)
  assert.equal((await f.db.get('SELECT status FROM file_requests WHERE id=$1', a.id))!.status, 'cancelled')
  await f.organizations.setTeamMember(f.owner.id, f.orgId, f.teamId, f.receiver.id, true)
  assert.equal((await f.ok(f.receiver, '/' + a.id)).status, 'cancelled')
  const b = await f.create()
  await f.organizations.setPermissions(f.owner.id, f.orgId, f.environment.id, f.sender.id, true, false, false)
  await f.organizations.setPermissions(f.owner.id, f.orgId, f.environment.id, f.sender.id, true, true, false)
  assert.equal((await f.ok(f.receiver, '/' + b.id)).status, 'cancelled')
  const c = await f.create()
  await f.organizations.removeMember(f.owner.id, f.orgId, f.receiver.id)
  assert.equal((await f.ok(f.receiver, '/' + c.id)).status, 'cancelled')
  assert.equal((await f.call(f.receiver, '', f.input())).status, 404)
  await f.db.run("INSERT INTO memberships VALUES ($1,$2,'member')", f.orgId, f.receiver.id)
  await f.organizations.setTeamMember(f.owner.id, f.orgId, f.teamId, f.receiver.id, true)
  await f.organizations.setPermissions(f.owner.id, f.orgId, f.environment.id, f.receiver.id, true, false, false)
  assert.equal((await f.ok(f.receiver, '/' + c.id)).status, 'cancelled')
})

test('device revoke, account disable and environment deletion cancel requests in their own mutation transactions', async t => {
  const f = await fixture(t), a = await f.create()
  const wire = await f.registry.beginAction(f.deviceSession(), 'revoke', f.identity.deviceId, f.identity.deviceId)
  await f.registry.complete(f.deviceSession(), wire.challenge.id, await answerDeviceChallenge(wire, wire.challenge, f.encryption, f.signing.privateKey, f.now()))
  assert.equal((await f.db.get('SELECT status FROM file_requests WHERE id=$1', a.id))!.status, 'cancelled')
  await f.db.run("UPDATE devices SET status='active' WHERE id=$1", f.identity.deviceId) // Fixture restoration only.
  const b = await f.create()
  await f.api.disableUser(f.sender.id)
  assert.equal((await f.db.get('SELECT status FROM file_requests WHERE id=$1', b.id))!.status, 'cancelled')
  await f.db.run('UPDATE users SET disabled=0 WHERE id=$1', f.sender.id)
  const c = await f.create()
  await f.organizations.remove(f.owner.id, f.orgId, 'environments', f.environment.id)
  assert.equal((await f.ok(f.receiver, '/' + c.id)).status, 'cancelled')
  assert.equal((await f.ok(f.receiver, '/' + c.id)).environment, undefined)
})

test('seven-day expiry, creation limits, maintenance and durable retries survive API restart', async t => {
  const f = await fixture(t), input = f.input(), a = await f.ok(f.receiver, '', input)
  await f.ok(f.sender, '/' + a.id + '/approve', { operationId: randomUUID() })
  await f.advance(7 * DAY - 1)
  assert.equal((await f.ok(f.receiver, '/' + a.id)).status, 'approved')
  await f.advance(1)
  assert.equal((await f.ok(f.receiver, '/' + a.id)).status, 'expired')
  const reopened = new AuthApi(f.storage.connect(), config, fetch, f.now)
  assert.deepEqual(await f.ok(f.receiver, '', input, reopened), a)
  for (let i=0; i<20; i++) await f.create()
  assert.equal((await f.call(f.receiver, '', f.input())).status, 429)
  await f.advance(10 * 60_000)
  for (let i=0; i<80; i++) {
    if (i && i % 20 === 0) await f.advance(10 * 60_000)
    await f.create()
  }
  await f.advance(10 * 60_000)
  assert.equal((await f.call(f.receiver, '', f.input())).status, 429)
  assert.equal((await f.db.get("SELECT count(*) AS n FROM file_requests WHERE status='pending'"))!.n, 100)
  await f.advance(38 * DAY)
  await f.api.prune() // Expire first; retain the minimal receipt for 30 days from processing.
  await f.advance(30 * DAY)
  await f.api.prune()
  assert.equal((await f.db.get('SELECT count(*) AS n FROM file_requests'))!.n, 0)
  assert.equal((await f.db.get('SELECT count(*) AS n FROM request_operations'))!.n, 0)
})

test('request HTTP rejects Origin, CSRF, unknown fields, oversized bodies and sessions lost while reading input', async t => {
  const f = await fixture(t)
  assert.equal((await f.call(f.receiver, '', f.input(), f.api, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await f.call(f.receiver, '', f.input(), f.api, { 'x-csrf-token': 'wrong' })).status, 403)
  assert.equal((await f.call(f.receiver, '', { ...f.input(), receiverId: f.owner.id })).status, 400)
  assert.equal((await f.call(f.receiver, '', { padding: 'x'.repeat(8192) })).status, 413)
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const reading = new Promise<void>(resolve => { started = resolve })
  const stream = new ReadableStream({ async pull(controller) { started(); await waiting; controller.enqueue(new TextEncoder().encode(JSON.stringify(f.input()))); controller.close() } })
  const request = new Request(config.apiOrigin + f.path, { method: 'POST', headers: { origin: config.webOrigin, cookie: 'envhandoff-dev-session=' + f.receiver.token, 'content-type': 'application/json', 'x-csrf-token': f.receiver.csrf }, body: stream, duplex: 'half' } as RequestInit)
  const result = f.api.handle(request)
  await reading
  await f.db.run('DELETE FROM sessions WHERE token_hash=$1', f.receiver.hash)
  release()
  assert.equal((await result).status, 401)
  assert.equal((await f.db.get('SELECT count(*) AS n FROM file_requests'))!.n, 0)
})

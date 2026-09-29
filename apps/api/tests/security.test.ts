import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { answerDeviceChallenge, deviceIdentity } from '@envhandoff/protocol/device-proof'
import type { EncryptedDeviceChallenge } from '@envhandoff/protocol/device-proof'
import { AuthApi } from '../src/auth.ts'
import { base32, openTotp, sealTotp, totp, totpCounter } from '../src/totp.ts'
import { testDatabase } from './database.ts'

const config = { development: true, webOrigin: 'http://localhost:5173', apiOrigin: 'http://localhost:3001', clientId: 'test', clientSecret: 'test', totpEncryptionKey: '01'.repeat(32) }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest()
const time = 1_800_000_000_000
async function fixture(t: TestContext) {
  const storage = await testDatabase(t), db = storage.connect()
  let now = time
  const userId = randomUUID(), token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url')
  await db.run('INSERT INTO users(id,github_id,login) VALUES ($1,$2,$3)', userId, '123', 'test-user')
  const sessionHash = hash(token).toString('base64url')
  await db.run('INSERT INTO sessions VALUES ($1,$2,$3,$4,$4)', sessionHash, userId, csrf, now)
  const api = new AuthApi(db, config, fetch, () => now)
  const call = (path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) => api.handle(new Request(config.apiOrigin + path, {
    method: body ? 'POST' : 'GET', headers: { origin: config.webOrigin, cookie: 'envhandoff-dev-session=' + token,
      ...(body ? { 'content-type': 'application/json', 'x-csrf-token': csrf } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined,
  }))
  const ok = async (path: string, body?: Record<string, unknown>) => {
    const response = await call(path, body), data = await response.json()
    assert.equal(response.status, 200, JSON.stringify(data)); return data
  }
  const join = async () => {
    const org = randomUUID()
    await db.run('INSERT INTO organizations(id,name) VALUES ($1,$2)', org, 'Test')
    await db.run('INSERT INTO memberships VALUES ($1,$2,$3)', org, userId, 'member')
    return org
  }
  return { db, api, userId, sessionHash, token, csrf, call, ok, join, now: () => now, advance: (ms: number) => { now += ms } }
}

// A synthetic authenticator with real P-256 signatures, independent of the verifier.
function authenticator() {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), id = randomBytes(32), jwk = keys.publicKey.export({ format: 'jwk' })
  const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]))
  const client = (type: string, challenge: string, origin: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  const authData = (counter: number, flags: number, rp = 'localhost') => {
    const count = Buffer.alloc(4); count.writeUInt32BE(counter)
    return Buffer.concat([hash(rp), Buffer.from([flags]), count])
  }
  return {
    id: id.toString('base64url'),
    registration(challenge: string, flags = 0x45, origin = config.webOrigin) {
      const length = Buffer.alloc(2); length.writeUInt16BE(id.length)
      const data = Buffer.concat([authData(0, flags), Buffer.alloc(16), length, id, cose])
      const attestation = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', data]] as [string, string | Map<string, string> | Uint8Array][]))
      return { id: id.toString('base64url'), rawId: id.toString('base64url'), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: client('webauthn.create', challenge, origin).toString('base64url'), attestationObject: Buffer.from(attestation).toString('base64url'), transports: ['internal'] } }
    },
    assertion(challenge: string, userId: string, counter = 1, flags = 5, origin = config.webOrigin, rp = 'localhost') {
      const data = authData(counter, flags, rp), json = client('webauthn.get', challenge, origin)
      return { id: id.toString('base64url'), rawId: id.toString('base64url'), type: 'public-key', clientExtensionResults: {}, response: {
        authenticatorData: data.toString('base64url'), clientDataJSON: json.toString('base64url'),
        signature: sign('sha256', Buffer.concat([data, hash(json)]), keys.privateKey).toString('base64url'), userHandle: Buffer.from(userId).toString('base64url'),
      } }
    },
  }
}
async function enroll(f: Awaited<ReturnType<typeof fixture>>, key = authenticator()) {
  const { id, options } = await f.ok('/security/passkeys/options', { label: 'Test key' })
  await f.ok('/security/passkeys/verify', { id, response: key.registration(options.challenge) })
  return key
}
async function reauth(f: Awaited<ReturnType<typeof fixture>>, key: ReturnType<typeof authenticator>, counter = 1) {
  const { id, options } = await f.ok('/security/reauth/options', {})
  await f.ok('/security/reauth/verify', { id, response: key.assertion(options.challenge, f.userId, counter) })
}
async function device(userId: string) {
  const encryption = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  return { encryption, signing, identity: await deviceIdentity(userId, randomUUID(), encryption.publicKey, signing.publicKey) }
}
async function proof(wire: EncryptedDeviceChallenge, keys: Awaited<ReturnType<typeof device>>, now = time) {
  return answerDeviceChallenge(wire, wire.challenge, keys.encryption, keys.signing.privateKey, now)
}

test('TOTP matches RFC 6238 SHA-1 vectors, accepts bounded drift, rejects replay, and encrypts secrets per account', () => {
  const secret = Buffer.from('12345678901234567890')
  for (const [seconds, expected] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']] as const) assert.equal(totp(secret, Math.floor(seconds / 30)), expected)
  assert.equal(base32(secret), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  assert.equal(totpCounter(secret, '287082', 59_000, -1), 1)
  assert.equal(totpCounter(secret, '287082', 60_000, -1), 1)
  assert.equal(totpCounter(secret, '287082', 90_000, -1), undefined)
  assert.equal(totpCounter(secret, '287082', 59_000, 1), undefined)
  assert.equal(totpCounter(secret, 287082, 59_000, -1), undefined)
  const key = randomBytes(32), sealed = sealTotp(secret, key, 'account-a')
  assert.deepEqual(openTotp(sealed, key, 'account-a'), secret)
  assert.throws(() => openTotp(sealed, key, 'account-b'))
  assert.throws(() => openTotp(sealed, randomBytes(32), 'account-a'))
})

test('passkey ceremonies enforce UV, origin, RP, session, account, single-use and expiry; enrollment is not reauthentication', async t => {
  const f = await fixture(t), key = authenticator()
  const begin = await f.ok('/security/passkeys/options', { label: 'Laptop' })
  assert.equal(begin.options.authenticatorSelection.userVerification, 'required')
  for (const response of [key.registration(begin.options.challenge, 0x41), key.registration(begin.options.challenge, 0x45, 'https://evil.example')]) {
    assert.equal((await f.call('/security/passkeys/verify', { id: begin.id, response })).status, 400)
  }
  await f.ok('/security/passkeys/verify', { id: begin.id, response: key.registration(begin.options.challenge) })
  assert.equal((await f.ok('/security')).reauthenticatedUntil, 0)
  assert.equal((await f.call('/security/passkeys/options', { label: 'Attacker' })).status, 403)
  const challenge = await f.ok('/security/reauth/options', {})
  const response = key.assertion(challenge.options.challenge, f.userId)
  const embedded = key.assertion(challenge.options.challenge, f.userId)
  const clientData = JSON.parse(Buffer.from(embedded.response.clientDataJSON, 'base64url').toString())
  embedded.response.clientDataJSON = Buffer.from(JSON.stringify({ ...clientData, crossOrigin: true })).toString('base64url')
  assert.equal((await f.call('/security/reauth/verify', { id: challenge.id, response: embedded })).status, 400)
  for (const invalid of [key.assertion(challenge.options.challenge, f.userId, 1, 1), key.assertion(challenge.options.challenge, randomUUID()),
    key.assertion(challenge.options.challenge, f.userId, 1, 5, 'https://evil.example'), key.assertion(challenge.options.challenge, f.userId, 1, 5, config.webOrigin, 'evil.example')]) {
    assert.equal((await f.call('/security/reauth/verify', { id: challenge.id, response: invalid })).status, 400)
  }
  const otherToken = randomBytes(32).toString('base64url')
  await f.db.run('INSERT INTO sessions VALUES ($1,$2,$3,$4,$4)', hash(otherToken).toString('base64url'), f.userId, f.csrf, time)
  assert.equal((await f.call('/security/reauth/verify', { id: challenge.id, response }, { cookie: 'envhandoff-dev-session=' + otherToken })).status, 409)
  const results = await Promise.all([f.call('/security/reauth/verify', { id: challenge.id, response }), f.call('/security/reauth/verify', { id: challenge.id, response })])
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
  assert.equal((await f.ok('/security')).reauthenticatedUntil, time + 15 * 60_000)
  const late = await f.ok('/security/reauth/options', {})
  f.advance(5 * 60_000)
  assert.equal((await f.call('/security/reauth/verify', { id: late.id, response: key.assertion(late.options.challenge, f.userId, 2) })).status, 409)
  f.advance(10 * 60_000)
  assert.equal((await f.ok('/security')).reauthenticatedUntil, 0)
  assert.equal((await f.call('/security/passkeys/options', { label: 'Expired' })).status, 403)
})

test('TOTP setup requires code confirmation, persists encrypted, prevents replay across sessions and rate limits failures', async t => {
  const f = await fixture(t)
  const setup = await f.ok('/security/totp/options', {})
  assert.equal((await f.ok('/security')).totp, false)
  const draft = (await f.db.get('SELECT challenge FROM security_challenges WHERE id=$1', setup.id))!.challenge as string
  assert.ok(!draft.includes(setup.secret))
  const secret = openTotp(draft, Buffer.from(config.totpEncryptionKey, 'hex'), f.userId)
  assert.equal(base32(secret), setup.secret)
  const code = totp(secret, Math.floor(f.now() / 30_000))
  await f.ok('/security/totp/confirm', { id: setup.id, code })
  assert.equal((await f.ok('/security')).reauthenticatedUntil, 0)
  assert.equal((await f.call('/security/totp/verify', { code })).status, 400)
  f.advance(30_000)
  const next = totp(secret, Math.floor(f.now() / 30_000))
  const results = await Promise.all([f.call('/security/totp/verify', { code: next }), f.call('/security/totp/verify', { code: next })])
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400])
  assert.equal((await f.call('/security/totp/remove', {})).status, 409)
  const key = await enroll(f)
  await f.ok('/security/totp/remove', {})
  assert.equal((await f.ok('/security')).reauthenticatedUntil, 0)
  await reauth(f, key)
  assert.equal((await f.call('/security/passkeys/remove', { id: key.id })).status, 409)
  // Exhaustion survives new requests and remains committed after failed checks.
  await f.call('/security/totp/verify', { code: 'bad' })
  assert.equal((await f.call('/security/totp/verify', { code: 'bad' })).status, 429)
})

test('device HTTP integrates registration, approval, revocation and recovery with live session and membership checks', async t => {
  const f = await fixture(t), key = await enroll(f)
  const first = await device(f.userId), second = await device(f.userId)
  assert.equal((await f.call('/security/devices/challenge', { action: 'register', identity: first.identity })).status, 403)
  const org = await f.join()
  for (const [keys, expected] of [[first, 'active'], [second, 'pending']] as const) {
    const wire = await f.ok('/security/devices/challenge', { action: 'register', identity: keys.identity })
    assert.equal((await f.ok('/security/devices/complete', { id: wire.challenge.id, proof: await proof(wire, keys) })).status, expected)
  }
  const approval = { action: 'approve', actorId: first.identity.deviceId, targetId: second.identity.deviceId }
  assert.equal((await f.call('/security/devices/challenge', approval)).status, 409)
  assert.equal((await f.call('/security/devices/challenge', { ...approval, reauthenticatedAt: time })).status, 400)
  await reauth(f, key)
  const pending = await f.ok('/security/devices/challenge', approval)
  const answer = await proof(pending, first)
  await f.db.run('UPDATE organizations SET active=0 WHERE id=$1', org)
  assert.equal((await f.call('/security/devices/complete', { id: pending.challenge.id, proof: answer })).status, 403)
  await f.db.run('UPDATE organizations SET active=1 WHERE id=$1', org)
  assert.equal((await f.ok('/security/devices/complete', { id: pending.challenge.id, proof: answer })).status, 'active')
  assert.equal((await f.call('/security/devices/complete', { id: pending.challenge.id, proof: answer })).status, 409)
  const revoke = await f.ok('/security/devices/challenge', { action: 'revoke', actorId: first.identity.deviceId, targetId: second.identity.deviceId })
  const revokeProof = await proof(revoke, first)
  f.advance(15 * 60_000)
  assert.equal((await f.call('/security/devices/complete', { id: revoke.challenge.id, proof: revokeProof })).status, 409)
  await reauth(f, key, 2)
  const replacement = await device(f.userId), recovery = await f.ok('/security/devices/challenge', { action: 'recover', identity: replacement.identity })
  assert.equal((await f.ok('/security/devices/complete', { id: recovery.challenge.id, proof: await proof(recovery, replacement, f.now()) })).status, 'active')
  const status = await f.ok('/security')
  assert.equal(status.devices.filter((d: { status: string }) => d.status === 'revoked').length, 2)
  const late = await f.ok('/security/devices/challenge', { action: 'revoke', actorId: replacement.identity.deviceId, targetId: replacement.identity.deviceId })
  assert.equal((await f.call('/auth/logout', {})).status, 204)
  assert.equal((await f.call('/security/devices/complete', { id: late.challenge.id, proof: await proof(late, replacement, f.now()) })).status, 401)
  assert.equal((await f.db.get('SELECT count(*) AS n FROM reauthentications'))!.n, 0)
  assert.equal((await f.db.get('SELECT count(*) AS n FROM security_challenges'))!.n, 0)
})

test('security boundary rejects foreign Origin, CSRF, body fields, stale bootstrap and disabled users', async t => {
  const f = await fixture(t)
  assert.equal((await f.call('/security/totp/options', {}, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await f.call('/security/totp/options', {}, { 'x-csrf-token': 'bad' })).status, 403)
  assert.equal((await f.call('/security/totp/options', { userId: randomUUID() })).status, 400)
  assert.equal((await f.call('/security/passkeys/options', { label: 'x'.repeat(9000) })).status, 413)
  f.advance(15 * 60_000)
  assert.equal((await f.call('/security/totp/options', {})).status, 403)
  await f.api.disableUser(f.userId)
  assert.equal((await f.call('/security')).status, 401)
})

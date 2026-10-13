import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, mkdir, rename, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { AuthApi } from '../src/auth.ts'
import { Deletions } from '../src/deletions.ts'
import { blockRestoredTransfers } from '../src/restore-safe.ts'
import { deletionHealth } from '../src/deletion-health.ts'
import { fixture, config, DAY } from './request-fixture.ts'
import { answerDeviceChallenge, deviceHash, deviceIdentity } from '@envhandoff/protocol/device-proof'
import type { PublicationAction, PublicationDeviceChallenge, EncryptedDeviceChallenge, DeviceIdentity } from '@envhandoff/protocol/device-proof'
import { signPublicationStatement, publicationPayloadDigest } from '@envhandoff/protocol/environment-files'
import type { PublicationStatement, PublicationWrapInput, EnvironmentFilesInfo } from '@envhandoff/protocol/environment-files'
import { sealEnvironmentBundle, wrapEnvironmentKey, unwrapEnvironmentKey, openEnvironmentBundle } from '../../web/src/lib/environment-keys.ts'

type Keys = { identity: DeviceIdentity; encryption: CryptoKeyPair; signing: CryptoKeyPair }
async function publication(t: TestContext) {
  const f = await fixture(t)
  const root = '/organizations/' + f.orgId + '/environments/' + f.environment.id + '/files'
  const call = (user: typeof f.receiver, suffix = '', body?: Record<string, unknown>, selectedApi = f.api) => selectedApi.handle(new Request(config.apiOrigin + root + suffix, {
    method: body ? 'POST' : 'GET', headers: { origin: config.webOrigin, cookie: 'envhandoff-dev-session=' + user.token,
      ...(body ? { 'content-type': 'application/json', 'x-csrf-token': user.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined,
  }))
  const ok = async (user: typeof f.receiver, suffix = '', body?: Record<string, unknown>, selectedApi = f.api) => {
    const response = await call(user, suffix, body, selectedApi), result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result)); return result
  }
  const publisher: Keys = { identity: f.identity, encryption: f.encryption, signing: f.signing }
  const register = async (user: typeof f.sender): Promise<Keys> => {
    const encryption = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
    const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
    const identity = await deviceIdentity(user.id, randomUUID(), encryption.publicKey, signing.publicKey)
    const auth = { userId: user.id, sessionId: user.hash, active: true, reauthenticatedAt: f.now() }
    const challenge = await f.registry.beginRegistration(auth, identity)
    await f.registry.complete(auth, challenge.challenge.id, await answerDeviceChallenge(challenge, challenge.challenge, encryption, signing.privateKey, f.now()))
    return { identity, encryption, signing }
  }
  const recipient = await register(f.sender)
  const info = (user = f.receiver, keys = publisher, selectedApi = f.api): Promise<EnvironmentFilesInfo> => ok(user, '?device=' + keys.identity.deviceId, undefined, selectedApi)
  const original = new Uint8Array([0xef, 0xbb, 0xbf, 65, 61, 49, 13, 10])
  const prepare = async (others: Keys[] = [], generation?: string) => {
    const head = generation ?? (await info()).generation
    const sealed = await sealEnvironmentBundle([{ file: new File([original], '.env'), path: 'apps/api/.env' }], 'Project', 'Development')
    const statement = await signPublicationStatement({ organizationId: f.orgId, projectId: f.project.id, environmentId: f.environment.id,
      versionId: randomUUID(), expectedGeneration: head, size: sealed.size, digest: sealed.digest, publisher: publisher.identity }, publisher.signing.privateKey)
    const wraps: PublicationWrapInput[] = await Promise.all([publisher, ...others].map(async keys => ({ recipientDeviceId: keys.identity.deviceId,
      wrap: await wrapEnvironmentKey(sealed.code, statement, publisher.identity, publisher.encryption, keys.identity, keys.encryption.publicKey) })))
    const input = { operationId: statement.versionId, deviceId: publisher.identity.deviceId, expectedGeneration: head, size: sealed.size, digest: sealed.digest, signature: statement.signature, wraps }
    return { statement, wraps, input, sealed }
  }
  const prove = async (statement: PublicationStatement, action: PublicationAction, user = f.receiver, keys = publisher, intent: { signature?: string; wraps?: PublicationWrapInput[]; targetDeviceId?: string; wrap?: string } = {}, target = keys.identity) => {
    const payloadDigest = await publicationPayloadDigest(action, intent)
    const wire: EncryptedDeviceChallenge<PublicationDeviceChallenge> = await ok(user, '/versions/' + statement.versionId + '/challenge', { action, deviceId: keys.identity.deviceId,
      ...(action === 'publication-grant' ? { targetDeviceId: target.deviceId } : {}), payloadDigest })
    const generation = action === 'publication-upload' ? statement.expectedGeneration : (await info(user, keys)).generation
    const expected: PublicationDeviceChallenge = { ...wire.challenge, action, actor: keys.identity, target, sessionHash: await deviceHash(user.hash),
      scope: { organizationId: f.orgId, projectId: f.project.id, environmentId: f.environment.id, versionId: statement.versionId, generation,
        digest: statement.digest, targetDeviceId: target.deviceId, payloadDigest } }
    return { deviceId: keys.identity.deviceId, id: wire.challenge.id, proof: await answerDeviceChallenge(wire, expected, keys.encryption, keys.signing.privateKey, f.now()) }
  }
  const upload = async (p: Awaited<ReturnType<typeof prepare>>, body: BodyInit = p.sealed.bytes, selectedApi = f.api) => {
    const proof = await prove(p.statement, 'publication-upload', f.receiver, publisher, { signature: p.statement.signature, wraps: p.wraps })
    return selectedApi.handle(new Request(config.apiOrigin + root + '/versions/' + p.statement.versionId + '/content', { method: 'POST',
      headers: { origin: config.webOrigin, cookie: 'envhandoff-dev-session=' + f.receiver.token, 'x-csrf-token': f.receiver.csrf,
        'content-type': 'application/octet-stream', 'x-device-challenge': proof.id, 'x-device-proof': proof.proof }, body, duplex: 'half' } as RequestInit))
  }
  const publish = async (others: Keys[] = []) => {
    const p = await prepare(others); await ok(f.receiver, '/versions', p.input)
    const response = await upload(p); assert.equal(response.status, 200, JSON.stringify(await response.clone().json())); return p
  }
  const download = async (p: Awaited<ReturnType<typeof prepare>>, user = f.sender, keys = recipient, selectedApi = f.api) => call(user, '/versions/' + p.statement.versionId + '/download', await prove(p.statement, 'publication-download', user, keys), selectedApi)
  const remove = async (p: Awaited<ReturnType<typeof prepare>>) => ok(f.receiver, '/versions/' + p.statement.versionId + '/remove', { expectedGeneration: (await info()).generation, ...await prove(p.statement, 'publication-remove') })
  return { ...f, root, callFiles: call, okFiles: ok, publisher, recipient, register, info, original, prepare, prove, upload, publish, download, remove }
}

test('published encrypted bytes survive logout/restart and seven days; only granted device decrypts paths; download leases settle', async t => {
  const f = await publication(t), p = await f.publish([f.recipient])
  const stored = await readFile(join(f.fileStoragePath, p.statement.versionId))
  assert.equal(stored.includes(Buffer.from('apps/api/.env')), false)
  const noGrant = await f.info(f.other, { ...f.publisher, identity: { ...f.publisher.identity, userId: f.other.id } })
  assert.equal(noGrant.access, 'no_device')
  await f.db.run('DELETE FROM sessions WHERE token_hash=$1', f.receiver.hash)
  await f.advance(8 * DAY)
  const restarted = new AuthApi(f.storage.connect(), f.localConfig, fetch, f.now)
  const info = await f.info(f.sender, f.recipient, restarted)
  assert.equal(info.access, 'available'); assert.equal(info.latest!.status, 'committed')
  assert.equal(info.wrap!.wrapperActive, true)
  const code = await unwrapEnvironmentKey(info.wrap!.wrap, p.statement, f.publisher.identity, f.publisher.encryption.publicKey, f.recipient.identity, f.recipient.encryption)
  const response = await f.download(p, f.sender, f.recipient, restarted); assert.equal(response.status, 200)
  const bytes = await response.arrayBuffer()
  const opened = await openEnvironmentBundle(bytes, p.statement, { organizationId: f.orgId, projectId: f.project.id, environmentId: f.environment.id }, code)
  assert.equal(opened.files[0]!.path, 'apps/api/.env'); assert.deepEqual(opened.files[0]!.bytes, f.original)
  assert.deepEqual(await f.db.get('SELECT bytes,finished FROM environment_download_leases'), { bytes: bytes.byteLength, finished: 1 })
})

test('CAS competing snapshots and delete/re-publish fence old drafts with fresh generation even when empty', async t => {
  const f = await publication(t), a = await f.prepare(), b = await f.prepare()
  await f.okFiles(f.receiver, '/versions', a.input); await f.okFiles(f.receiver, '/versions', b.input)
  const writing = (p: typeof a) => {
    let release!: () => void
    const wait = new Promise<void>(r => { release = r })
    const body = new ReadableStream({ async pull(controller) { await wait; controller.enqueue(new Uint8Array(p.sealed.bytes)); controller.close() } })
    return { release, operation: f.upload(p, body) }
  }
  const first = writing(a), second = writing(b)
  for (let i = 0; i < 100; i++) {
    if ((await f.db.get("SELECT count(*) AS n FROM environment_versions WHERE status='writing'"))!.n === 2) break
    await new Promise(r => setTimeout(r, 5))
  }
  assert.equal((await f.db.get("SELECT count(*) AS n FROM environment_versions WHERE status='writing'"))!.n, 2)
  first.release(); assert.equal((await first.operation).status, 200)
  second.release(); const loser = await second.operation
  assert.equal(loser.status, 409); assert.equal((await loser.json()).error, 'version_conflict')
  assert.equal((await f.db.get('SELECT status FROM environment_versions WHERE id=$1', b.statement.versionId))!.status, 'failed')
  const head = await f.info(); assert.notEqual(head.generation, a.statement.expectedGeneration)
  const stale = await f.prepare([], head.generation); await f.okFiles(f.receiver, '/versions', stale.input)
  await f.remove(a); const empty = await f.info(); assert.equal(empty.latest, null); assert.notEqual(empty.generation, head.generation)
  assert.equal((await f.callFiles(f.receiver, '/versions', (await f.prepare([], head.generation)).input)).status, 409)
  const c = await f.publish(); assert.equal((await f.info()).latest!.versionId, c.statement.versionId)
  assert.equal((await f.callFiles(f.receiver, '/versions/' + stale.statement.versionId + '/challenge', { action: 'publication-upload', deviceId: f.identity.deviceId, payloadDigest: await publicationPayloadDigest('publication-upload', { signature: stale.statement.signature, wraps: stale.wraps }) })).status, 409)
})

test('cancel before reservation survives cleanup; stream cancellation wins and retains writer lease until settlement', async t => {
  const f = await publication(t), p = await f.prepare(), path = '/versions/' + p.statement.versionId
  await f.okFiles(f.receiver, path + '/cancel', { operationId: randomUUID() }); await f.api.prune()
  assert.equal((await f.okFiles(f.receiver, '/versions', p.input)).status, 'cancelled')
  assert.equal(await f.db.get('SELECT id FROM environment_versions WHERE id=$1', p.statement.versionId), undefined)
  const q = await f.prepare(); await f.okFiles(f.receiver, '/versions', q.input)
  let release!: () => void, reading!: () => void
  const wait = new Promise<void>(r => { release = r }), started = new Promise<void>(r => { reading = r })
  const stream = new ReadableStream({ async pull(controller) { reading(); await wait; controller.enqueue(new Uint8Array(q.sealed.bytes)); controller.close() } })
  const operation = f.upload(q, stream); await started
  for (let i = 0; i < 100; i++) { if ((await f.db.get('SELECT status FROM environment_versions WHERE id=$1', q.statement.versionId))!.status === 'writing') break; await new Promise(r => setTimeout(r, 5)) }
  await f.okFiles(f.receiver, '/versions/' + q.statement.versionId + '/cancel', { operationId: randomUUID() })
  assert.notEqual((await f.db.get('SELECT write_until FROM environment_versions WHERE id=$1', q.statement.versionId))!.write_until, null)
  await f.api.prune(); release(); assert.equal((await operation).status, 409)
  await f.api.prune(); assert.deepEqual(await readdir(f.fileStoragePath), [])
})

test('explicit key grants bind payload and target; revoked recipient never regains an old grant after rights return', async t => {
  const f = await publication(t), p = await f.publish()
  assert.equal((await f.info(f.sender, f.recipient)).access, 'needs_grant')
  const wrap = await wrapEnvironmentKey(p.sealed.code, p.statement, f.identity, f.encryption, f.recipient.identity, f.recipient.encryption.publicKey)
  const intent = { targetDeviceId: f.recipient.identity.deviceId, wrap }, proof = await f.prove(p.statement, 'publication-grant', f.receiver, f.publisher, intent, f.recipient.identity)
  const path = '/versions/' + p.statement.versionId + '/grants'
  const changedWrap = await wrapEnvironmentKey(p.sealed.code, p.statement, f.identity, f.encryption, f.recipient.identity, f.recipient.encryption.publicKey)
  assert.equal((await f.callFiles(f.receiver, path, { ...proof, ...intent, wrap: changedWrap })).status, 403)
  assert.equal((await f.callFiles(f.receiver, path, { ...proof, ...intent, targetDeviceId: f.identity.deviceId })).status, 403)
  await f.okFiles(f.receiver, path, { ...proof, ...intent })
  assert.equal((await f.info(f.sender, f.recipient)).access, 'available')
  const downloadProof = await f.prove(p.statement, 'publication-download', f.sender, f.recipient)
  await f.organizations.setPermissions(f.owner.id, f.orgId, f.environment.id, f.sender.id, false, true, false)
  await f.organizations.setPermissions(f.owner.id, f.orgId, f.environment.id, f.sender.id, true, true, false)
  assert.equal((await f.info(f.sender, f.recipient)).access, 'needs_grant')
  assert.equal((await f.callFiles(f.sender, '/versions/' + p.statement.versionId + '/download', downloadProof)).status, 403)
  const fresh = await f.prove(p.statement, 'publication-grant', f.receiver, f.publisher, intent, f.recipient.identity)
  await f.okFiles(f.receiver, path, { ...fresh, ...intent })
  const bytes = await f.download(p); assert.equal(bytes.status, 200); await bytes.arrayBuffer()
})

test('ordinary publisher device revoke and departure preserve other recipients historical wraps and statement', async t => {
  const f = await publication(t), p = await f.publish([f.recipient])
  await f.db.transaction(async () => {
    await f.db.run("UPDATE devices SET status='revoked' WHERE id=$1", f.identity.deviceId)
    await f.organizations.removeMember(f.owner.id, f.orgId, f.receiver.id)
  })
  const info = await f.info(f.sender, f.recipient)
  assert.equal(info.access, 'available'); assert.equal(info.latest!.publisherActive, false); assert.equal(info.wrap!.wrapperActive, false)
  const code = await unwrapEnvironmentKey(info.wrap!.wrap, p.statement, f.identity, f.encryption.publicKey, f.recipient.identity, f.recipient.encryption)
  const response = await f.download(p); assert.equal(response.status, 200)
  assert.deepEqual((await openEnvironmentBundle(await response.arrayBuffer(), p.statement, { organizationId: f.orgId, projectId: f.project.id, environmentId: f.environment.id }, code)).files[0]!.bytes, f.original)
  assert.equal((await f.db.get('SELECT count(*) AS n FROM environment_key_wraps WHERE recipient_device_id=$1', f.identity.deviceId))!.n, 0)
})

test('permanent account ledger erasure empties head, scrubs publisher/issuer keys, retains bytes until erase, reapplies after metadata restore', async t => {
  const f = await publication(t), p = await f.publish([f.recipient]), version = await f.db.get('SELECT * FROM environment_versions WHERE id=$1', p.statement.versionId), head = await f.db.get('SELECT * FROM environment_publication_heads WHERE environment_id=$1', f.environment.id)
  const preview = await f.api.handle(new Request(config.apiOrigin + '/security', { headers: { origin: config.webOrigin, cookie: 'envhandoff-dev-session=' + f.receiver.token } }))
  assert.equal((await preview.json()).accountDeletionPublishedEnvironmentCount, 1)
  const ledger = new Deletions(f.localConfig.deletionLedgerPath)
  await ledger.record('user', f.receiver.id, f.now()); await ledger.sync(f.db, f.now())
  const after = await f.info(f.sender, f.recipient)
  assert.equal(after.latest, null); assert.equal(after.endReason, 'publisher_erased'); assert.notEqual(after.generation, head!.generation)
  assert.deepEqual(await f.db.get('SELECT publisher_user_id,publisher_device_id,publisher_identity,signature,deleted_at FROM environment_versions WHERE id=$1', p.statement.versionId), { publisher_user_id: '', publisher_device_id: '', publisher_identity: '{}', signature: '', deleted_at: null })
  assert.equal((await f.db.get('SELECT sum(size)::bigint AS n FROM stored_objects WHERE deleted_at IS NULL'))!.n, p.sealed.size)
  await f.db.run('UPDATE environment_versions SET publisher_user_id=$1,publisher_device_id=$2,publisher_identity=$3,signature=$4,ended_at=NULL,end_reason=NULL WHERE id=$5', version!.publisher_user_id, version!.publisher_device_id, version!.publisher_identity, version!.signature, p.statement.versionId)
  await f.db.run('UPDATE environment_publication_heads SET version_id=$1,generation=$2,end_reason=NULL WHERE environment_id=$3', p.statement.versionId, head!.generation, f.environment.id)
  // Applied deletion marker remains: restoring only the new tables must still be detected.
  await ledger.sync(f.db, f.now())
  assert.equal((await f.info(f.sender, f.recipient)).latest, null)
  assert.equal((await f.db.get('SELECT publisher_identity FROM environment_versions WHERE id=$1', p.statement.versionId))!.publisher_identity, '{}')
  await f.api.prune(); assert.deepEqual(await readdir(f.fileStoragePath), [])
})

test('restore refreshes live AND empty head tokens, blocks grants and stale prepared versions without unsafe counters', async t => {
  const f = await publication(t), p = await f.publish([f.recipient]), emptyEnv = await f.organizations.createEnvironment(f.owner.id, f.orgId, f.project.id, 'Empty')
  await f.organizations.setPermissions(f.owner.id, f.orgId, emptyEnv.id, f.receiver.id, true, true, false)
  const emptyRoot = f.root.replace(f.environment.id, emptyEnv.id), emptyInfo = await f.api.handle(new Request(config.apiOrigin + emptyRoot, { headers: { origin: config.webOrigin, cookie: 'envhandoff-dev-session=' + f.receiver.token } }))
  const emptyGeneration = (await emptyInfo.json()).generation, before = (await f.info()).generation
  const preview = await blockRestoredTransfers(f.db, false, f.now()); assert.equal(preview.environmentFiles, 1)
  assert.equal((await f.info()).generation, before)
  await blockRestoredTransfers(f.db, true, f.now())
  assert.notEqual((await f.info()).generation, before); assert.equal((await f.info()).endReason, 'restored')
  const emptyHead = await f.db.get('SELECT generation FROM environment_publication_heads WHERE environment_id=$1', emptyEnv.id)
  assert.notEqual(emptyHead!.generation, emptyGeneration)
  assert.equal((await f.db.get('SELECT count(*) AS n FROM environment_key_wraps'))!.n, 0)
  assert.equal((await f.db.get('SELECT end_reason FROM environment_versions WHERE id=$1', p.statement.versionId))!.end_reason, 'restored')
  const firstApplyGeneration = (await f.info()).generation
  await blockRestoredTransfers(f.db, true, f.now()); assert.notEqual((await f.info()).generation, firstApplyGeneration)
})

test('failed physical erase keeps shared quota and deletion health until unlink succeeds', async t => {
  const f = await publication(t), p = await f.publish(), object = join(f.fileStoragePath, p.statement.versionId), kept = object + '-kept'
  await f.remove(p); await rename(object, kept); await mkdir(object)
  await f.api.prune()
  assert.equal((await f.db.get('SELECT deleted_at FROM environment_versions WHERE id=$1', p.statement.versionId))!.deleted_at, null)
  assert.equal((await f.db.get('SELECT sum(size)::bigint AS n FROM stored_objects WHERE deleted_at IS NULL'))!.n, p.sealed.size)
  await f.advance(DAY)
  assert.equal((await deletionHealth(f.db, f.now())).environmentFiles.overdueDeletions.count, 1)
  await rmdir(object); await rename(kept, object); await f.api.prune()
  assert.equal((await f.db.get('SELECT sum(size)::bigint AS n FROM stored_objects WHERE deleted_at IS NULL'))!.n, null)
})

test('beta pause preserves download/remove/cancel but blocks new publication and grants; org/device/rights all checked', async t => {
  const f = await publication(t), p = await f.publish([f.recipient]), paused = new AuthApi(f.storage.connect(), { ...f.localConfig, acceptNewTransfers: false }, fetch, f.now)
  assert.equal((await f.callFiles(f.receiver, '/versions', (await f.prepare()).input, paused)).status, 503)
  const proof = await f.prove(p.statement, 'publication-download', f.sender, f.recipient)
  const download = await f.callFiles(f.sender, '/versions/' + p.statement.versionId + '/download', proof, paused)
  assert.equal(download.status, 200); await download.arrayBuffer()
  const grantPayload = await publicationPayloadDigest('publication-grant', { targetDeviceId: f.identity.deviceId, wrap: p.wraps[0]!.wrap })
  assert.equal((await f.callFiles(f.receiver, '/versions/' + p.statement.versionId + '/challenge', { action: 'publication-grant', deviceId: f.identity.deviceId, targetDeviceId: f.identity.deviceId, payloadDigest: grantPayload }, paused)).status, 503)
  const wrongOrg = await f.api.handle(new Request(config.apiOrigin + f.root.replace(f.orgId, randomUUID()), { headers: { origin: config.webOrigin, cookie: 'envhandoff-dev-session=' + f.receiver.token } }))
  assert.equal(wrongOrg.status, 404)
  const ownerProof = { ...await f.prove(p.statement, 'publication-download'), deviceId: f.identity.deviceId }
  assert.equal((await f.callFiles(f.owner, '/versions/' + p.statement.versionId + '/download', ownerProof)).status, 403)
  await f.organizations.setPermissions(f.owner.id, f.orgId, f.environment.id, f.receiver.id, true, false, false)
  assert.equal((await f.callFiles(f.receiver, '/versions', (await f.prepare()).input)).status, 403)
  await f.organizations.setPermissions(f.owner.id, f.orgId, f.environment.id, f.receiver.id, true, true, false)
  const removal = { expectedGeneration: (await f.info()).generation, ...await f.prove(p.statement, 'publication-remove') }
  assert.equal((await f.callFiles(f.receiver, '/versions/' + p.statement.versionId + '/remove', removal, paused)).status, 200)
})

test('permission/session/device changes during stream cannot publish or replace existing latest files', async t => {
  for (const kind of ['permission', 'session', 'device'] as const) await t.test(kind, async t => {
    const f = await publication(t), old = await f.publish([f.recipient]), p = await f.prepare([f.recipient])
    await f.okFiles(f.receiver, '/versions', p.input)
    let release!: () => void, reading!: () => void
    const wait = new Promise<void>(r => { release = r }), started = new Promise<void>(r => { reading = r })
    const stream = new ReadableStream({ async pull(controller) { reading(); await wait; controller.enqueue(new Uint8Array(p.sealed.bytes)); controller.close() } })
    const operation = f.upload(p, stream); await started
    for (let i = 0; i < 100; i++) { if ((await f.db.get('SELECT status FROM environment_versions WHERE id=$1', p.statement.versionId))!.status === 'writing') break; await new Promise(r => setTimeout(r, 5)) }
    if (kind === 'permission') await f.organizations.setPermissions(f.owner.id, f.orgId, f.environment.id, f.receiver.id, true, false, false)
    if (kind === 'session') await f.db.run('DELETE FROM sessions WHERE token_hash=$1', f.receiver.hash)
    if (kind === 'device') {
      const auth = f.deviceSession(), wire = await f.registry.beginAction(auth, 'revoke', f.identity.deviceId, f.identity.deviceId)
      await f.registry.complete(auth, wire.challenge.id, await answerDeviceChallenge(wire, wire.challenge, f.encryption, f.signing.privateKey, f.now()))
    }
    release(); const response = await operation
    assert.equal(response.status, kind === 'session' ? 401 : 403)
    assert.equal((await f.info(f.sender, f.recipient)).latest!.versionId, old.statement.versionId)
    assert.notEqual((await f.db.get('SELECT ended_at FROM environment_versions WHERE id=$1', p.statement.versionId))!.ended_at, null)
    await f.api.prune(); assert.deepEqual(await readdir(f.fileStoragePath), [old.statement.versionId])
  })
})

test('shared upload/download quotas include publication reservations and other delivery kinds', async t => {
  const f = await publication(t), p = await f.publish([f.recipient])
  // Other delivery storage already uses the same view, including physical erase backlog.
  const shareId = randomUUID()
  await f.db.run(`INSERT INTO external_shares(id,org_id,environment_id,creator_id,size,digest,retention_days,status,created_at,ended_at)
    VALUES($1,$2,$3,$4,16777216,$5,1,'failed',$6,$6)`, shareId, f.orgId, f.environment.id, f.receiver.id, p.statement.digest, f.now())
  assert.equal((await f.db.get('SELECT sum(size)::bigint AS n FROM stored_objects WHERE org_id=$1 AND deleted_at IS NULL', f.orgId))!.n, 16777216 + p.sealed.size)
  // A different share consumes the whole org's daily allowance before this download.
  await f.db.run('INSERT INTO share_download_leases(id,share_id,org_id,day,bytes,expires_at,finished) VALUES($1,$2,$3,$4,1073741824,$5,1)', randomUUID(), shareId, f.orgId, Math.floor(f.now() / DAY), f.now() + 60_000)
  assert.equal((await f.download(p)).status, 429)
  await f.db.run('DELETE FROM share_download_leases')
  const leases = []
  for (let i = 0; i < 3; i++) {
    const id = randomUUID(); leases.push(id)
    await f.db.run('INSERT INTO environment_download_leases(id,version_id,org_id,day,bytes,expires_at) VALUES($1,$2,$3,$4,$5,$6)', id, p.statement.versionId, f.orgId, Math.floor(f.now() / DAY), p.sealed.size, f.now() + 60_000)
  }
  assert.equal((await f.download(p)).status, 429)
  await f.db.run('UPDATE environment_download_leases SET finished=1')
  const response = await f.download(p); assert.equal(response.status, 200); await response.arrayBuffer()
})

test('project/environment and durable organization deletion end snapshots without dropping byte accounting', async t => {
  for (const kind of ['environments', 'projects', 'organization'] as const) await t.test(kind, async t => {
    const f = await publication(t), p = await f.publish([f.recipient])
    if (kind === 'organization') {
      const ledger = new Deletions(f.localConfig.deletionLedgerPath)
      await ledger.record('organization', f.orgId, f.now()); await ledger.sync(f.db, f.now())
    } else await f.organizations.remove(f.owner.id, f.orgId, kind, kind === 'projects' ? f.project.id : f.environment.id)
    assert.equal((await f.db.get('SELECT end_reason FROM environment_versions WHERE id=$1', p.statement.versionId))!.end_reason, 'environment_deleted')
    assert.equal((await f.db.get('SELECT count(*) AS n FROM environment_key_wraps'))!.n, 0)
    assert.equal((await f.db.get('SELECT deleted_at FROM stored_objects WHERE id=$1', p.statement.versionId))!.deleted_at, null)
    assert.equal((await f.callFiles(f.sender, '?device=' + f.recipient.identity.deviceId)).status, 404)
    await f.api.prune(); assert.deepEqual(await readdir(f.fileStoragePath), [])
  })
})

test('legacy team upload cannot reserve a live publication object ID or erase its blob on cancellation and prune', async t => {
  const f = await publication(t), p = await f.publish([f.recipient]), request = await f.create()
  await f.ok(f.sender, '/' + request.id + '/approve', { operationId: randomUUID() })
  const collision = await f.call(f.sender, '/' + request.id + '/uploads', { operationId: p.statement.versionId,
    deviceId: f.recipient.identity.deviceId, size: 174, digest: p.statement.digest, retentionDays: 1 })
  assert.equal(collision.status, 409); assert.equal((await collision.json()).error, 'operation_conflict')
  assert.equal(await f.db.get('SELECT id FROM uploads WHERE id=$1', p.statement.versionId), undefined)
  await f.ok(f.sender, '/' + request.id + '/cancel', { operationId: randomUUID() })
  await f.api.prune()
  assert.deepEqual(await readFile(join(f.fileStoragePath, p.statement.versionId)), Buffer.from(p.sealed.bytes))
  const download = await f.download(p); assert.equal(download.status, 200)
  assert.deepEqual(await download.arrayBuffer(), p.sealed.bytes)
})

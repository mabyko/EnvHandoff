import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answerDeviceChallenge, deviceHash, deviceIdentity, encodeDeviceBytes, encryptDeviceChallenge, verifyDeviceProof } from '@envhandoff/protocol/device-proof'
import type { DeviceChallenge, PublicationDeviceChallenge } from '@envhandoff/protocol/device-proof'
import { publicationPayloadDigest, publicationStatementBytes, publicationStatementHash, signPublicationStatement, validatePublicationWrap, verifyPublicationStatement } from '@envhandoff/protocol/environment-files'
import type { UnsignedPublicationStatement } from '@envhandoff/protocol/environment-files'
import { generateDeviceKey } from '../src/lib/team-crypto.ts'

async function device() {
  const encryption = await generateDeviceKey()
  const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  return { encryption, signing, identity: await deviceIdentity(crypto.randomUUID(), crypto.randomUUID(), encryption.publicKey, signing.publicKey) }
}

async function statement(publisher: Awaited<ReturnType<typeof device>>) {
  const unsigned: UnsignedPublicationStatement = {
    organizationId: crypto.randomUUID(), projectId: crypto.randomUUID(), environmentId: crypto.randomUUID(),
    versionId: crypto.randomUUID(), expectedGeneration: crypto.randomUUID(), size: 40,
    digest: await deviceHash(new Uint8Array(40)), publisher: publisher.identity,
  }
  return signPublicationStatement(unsigned, publisher.signing.privateKey)
}

function opaqueWrap() {
  const bytes = crypto.getRandomValues(new Uint8Array(124)); bytes[0] = 4
  return encodeDeviceBytes(bytes)
}

test('publisher signature authenticates every scope, digest, size and both public keys', async () => {
  const publisher = await device(), other = await device(), signed = await statement(publisher)
  assert(await verifyPublicationStatement(signed))
  for (const key of ['organizationId', 'projectId', 'environmentId', 'versionId', 'expectedGeneration'] as const) {
    assert.equal(await verifyPublicationStatement({ ...signed, [key]: crypto.randomUUID() }), false)
  }
  assert.equal(await verifyPublicationStatement({ ...signed, size: 41 }), false)
  assert.equal(await verifyPublicationStatement({ ...signed, digest: await deviceHash('different ciphertext') }), false)
  for (const key of ['userId', 'deviceId', 'encryptionKey', 'signingKey'] as const) {
    assert.equal(await verifyPublicationStatement({ ...signed, publisher: { ...signed.publisher, [key]: other.identity[key] } }), false)
  }
  assert.equal(await verifyPublicationStatement({ ...signed, signature: signed.signature + '=' }), false)
  assert.equal(await verifyPublicationStatement({ ...signed, size: 16 * 1024 * 1024 + 1 }), false)
  assert.throws(() => publicationStatementBytes({ ...signed, expectedGeneration: '0' }))
  const reordered = Object.fromEntries(Object.entries(signed).reverse()) as typeof signed
  assert.deepEqual(publicationStatementBytes(reordered), publicationStatementBytes(signed))
  assert.equal(await publicationStatementHash(reordered), await publicationStatementHash(signed))
})

test('publication intent hashes bind sorted unique recipient wraps and reject extra or malformed data', async () => {
  const publisher = await device(), signed = await statement(publisher)
  const a = { recipientDeviceId: crypto.randomUUID(), wrap: opaqueWrap() }, b = { recipientDeviceId: crypto.randomUUID(), wrap: opaqueWrap() }
  assert.equal(a.wrap.length, 166)
  assert.equal(validatePublicationWrap(a.wrap), a.wrap)
  assert.throws(() => validatePublicationWrap(a.wrap + '='))
  const intent = { signature: signed.signature, wraps: [a, b] }
  const digest = await publicationPayloadDigest('publication-upload', intent)
  assert.equal(digest, await publicationPayloadDigest('publication-upload', { ...intent, wraps: [b, a] }))
  assert.notEqual(digest, await publicationPayloadDigest('publication-upload', { ...intent, wraps: [a, { ...b, wrap: opaqueWrap() }] }))
  await assert.rejects(publicationPayloadDigest('publication-upload', { ...intent, wraps: [a, a] }))
  await assert.rejects(publicationPayloadDigest('publication-upload', { ...intent, wraps: [] }))
  await assert.rejects(publicationPayloadDigest('publication-download', { wrap: a.wrap }))
  const grant = { targetDeviceId: a.recipientDeviceId, wrap: a.wrap }
  assert.notEqual(await publicationPayloadDigest('publication-grant', grant), await publicationPayloadDigest('publication-grant', { ...grant, targetDeviceId: b.recipientDeviceId }))
  assert.notEqual(await publicationPayloadDigest('publication-download'), await publicationPayloadDigest('publication-remove'))
})

test('publication device proof binds generation, full recipient identity and action intent without changing v3', async () => {
  const actor = await device(), recipient = await device(), signed = await statement(actor)
  const challenge: PublicationDeviceChallenge = {
    id: crypto.randomUUID(), action: 'publication-grant', sessionHash: await deviceHash('test session'),
    actor: actor.identity, target: recipient.identity, issuedAt: 1000, expiresAt: 301000,
    scope: { organizationId: signed.organizationId, projectId: signed.projectId, environmentId: signed.environmentId,
      versionId: signed.versionId, generation: crypto.randomUUID(), digest: signed.digest,
      targetDeviceId: recipient.identity.deviceId,
      payloadDigest: await publicationPayloadDigest('publication-grant', { targetDeviceId: recipient.identity.deviceId, wrap: opaqueWrap() }),
    },
  }
  const sealed = await encryptDeviceChallenge(challenge)
  const proof = await answerDeviceChallenge(sealed.wire, challenge, actor.encryption, actor.signing.privateKey, 2000)
  assert(await verifyDeviceProof(challenge, proof, sealed.secretHash))
  for (const key of Object.keys(challenge.scope) as (keyof typeof challenge.scope)[]) {
    const changed = { ...challenge, scope: { ...challenge.scope, [key]: ['digest', 'payloadDigest'].includes(key) ? await deviceHash('changed intent') : crypto.randomUUID() } }
    assert.equal(await verifyDeviceProof(changed, proof, sealed.secretHash), false)
    await assert.rejects(answerDeviceChallenge(sealed.wire, changed, actor.encryption, actor.signing.privateKey, 2000))
  }
  assert.equal(await verifyDeviceProof({ ...challenge, target: actor.identity }, proof, sealed.secretHash), false)
  const legacy: DeviceChallenge = {
    id: challenge.id, action: 'upload', sessionHash: challenge.sessionHash, actor: actor.identity, target: actor.identity,
    issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
    scope: { organizationId: signed.organizationId, requestId: signed.environmentId, transferId: signed.versionId, digest: signed.digest },
  }
  assert.equal(await verifyDeviceProof(legacy, proof, sealed.secretHash), false)
  const old = await encryptDeviceChallenge(legacy)
  const oldProof = await answerDeviceChallenge(old.wire, legacy, actor.encryption, actor.signing.privateKey, 2000)
  assert(await verifyDeviceProof(legacy, oldProof, old.secretHash))
  assert.equal(await verifyDeviceProof(challenge, oldProof, old.secretHash), false)
  await assert.rejects(encryptDeviceChallenge({ ...challenge, action: 'publication-download' }))
})

// TEST ONLY. Independent Node crypto implementation of an environment publication:
// v1 bundle, ES256 publisher statement and RFC 9180 Auth per-device key wrap.
// Fixed keys/nonces are public fixtures and must never be used for real files.
import { createCipheriv, createECDH, createHash, createHmac, createPrivateKey, sign } from 'node:crypto'

const concat = (...values) => Buffer.concat(values.map((value) => typeof value === 'string' ? Buffer.from(value) : value))
const hash = (bytes) => createHash('sha256').update(bytes).digest()
const hmac = (key, bytes) => createHmac('sha256', key).update(bytes).digest()
const empty = Buffer.alloc(0)
const u16 = (value) => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes }
const extract = (suite, salt, label, ikm) => hmac(salt, concat('HPKE-v1', suite, label, ikm))
const expand = (suite, prk, label, info, length) => hmac(prk, concat(u16(length), 'HPKE-v1', suite, label, info, Buffer.from([1]))).subarray(0, length)
const encrypt = (key, nonce, aad, plaintext) => {
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  return concat(cipher.update(plaintext), cipher.final(), cipher.getAuthTag())
}
const keyPair = (scalar) => {
  const key = createECDH('prime256v1'), privateKey = Buffer.alloc(32)
  privateKey[31] = scalar
  key.setPrivateKey(privateKey)
  return key
}
const jwk = (key, ops) => {
  const publicKey = key.getPublicKey()
  return { kty: 'EC', crv: 'P-256', ext: true, key_ops: ops, x: publicKey.subarray(1, 33).toString('base64url'), y: publicKey.subarray(33).toString('base64url'), d: key.getPrivateKey().toString('base64url') }
}
const identity = (userId, deviceId, encryption, signing) => ({ userId, deviceId, encryptionKey: encryption.getPublicKey().toString('base64url'), signingKey: signing.getPublicKey().toString('base64url') })
const values = (id) => [id.userId, id.deviceId, id.encryptionKey, id.signingKey]

// ES256 signatures are randomized; pass the stored signature to reproduce the vector exactly.
export function referenceEnvironmentPublication(payload, ids, signature) {
  const wrapperKey = keyPair(1), recipientKey = keyPair(2), ephemeral = keyPair(3), wrapperSigning = keyPair(4), recipientSigning = keyPair(5)
  const wrapper = identity(ids.publisherUserId, ids.publisherDeviceId, wrapperKey, wrapperSigning)
  const recipient = identity(ids.recipientUserId, ids.recipientDeviceId, recipientKey, recipientSigning)

  const bundleHeader = concat('ENVHANDOFF', u16(1), Buffer.alloc(12))
  const bundleKey = Buffer.alloc(32, 7)
  const bundle = concat(bundleHeader, encrypt(bundleKey, bundleHeader.subarray(12), bundleHeader, JSON.stringify(payload)))
  const unsigned = { organizationId: ids.organizationId, projectId: ids.projectId, environmentId: ids.environmentId, versionId: ids.versionId,
    expectedGeneration: ids.generation, size: bundle.length, digest: hash(bundle).toString('base64url'), publisher: wrapper }
  const statementBytes = Buffer.from(JSON.stringify(['EnvHandoff environment publication v1', unsigned.organizationId, unsigned.projectId,
    unsigned.environmentId, unsigned.versionId, unsigned.expectedGeneration, unsigned.size, unsigned.digest, ...values(wrapper)]))
  signature ??= sign('sha256', statementBytes, { key: createPrivateKey({ key: jwk(wrapperSigning, ['sign']), format: 'jwk' }), dsaEncoding: 'ieee-p1363' }).toString('base64url')

  const kemSuite = concat('KEM', u16(16)), hpkeSuite = concat('HPKE', u16(16), u16(1), u16(2))
  const enc = ephemeral.getPublicKey()
  const dh = concat(ephemeral.computeSecret(recipientKey.getPublicKey()), wrapperKey.computeSecret(recipientKey.getPublicKey()))
  const sharedSecret = expand(kemSuite, extract(kemSuite, empty, 'eae_prk', dh), 'shared_secret', concat(enc, recipientKey.getPublicKey(), wrapperKey.getPublicKey()), 32)
  const info = hash(JSON.stringify(['EnvHandoff environment key v1', hash(statementBytes).toString('base64url'), ...values(wrapper), ...values(recipient)]))
  const context = concat(Buffer.from([2]), extract(hpkeSuite, empty, 'psk_id_hash', empty), extract(hpkeSuite, empty, 'info_hash', info))
  const secret = extract(hpkeSuite, sharedSecret, 'secret', empty)
  const aad = concat('ENVHENVK', u16(1), hash(statementBytes))
  const wrap = concat(enc, encrypt(expand(hpkeSuite, secret, 'key', context, 32), expand(hpkeSuite, secret, 'base_nonce', context, 12), aad, bundleKey.toString('base64url')))
  return {
    note: 'Public test-only vector, independently generated with Node crypto by environment-reference.mjs. Never use these keys/nonces in production.',
    ids, payload,
    statement: { ...unsigned, signature },
    recipient,
    recipientPrivateKey: jwk(recipientKey, ['deriveBits']),
    wrap: wrap.toString('base64url'),
    bundleBase64: bundle.toString('base64'),
  }
}

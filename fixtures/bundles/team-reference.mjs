// TEST ONLY. Independent Node crypto implementation of RFC 9180 Auth key wrapping.
// Fixed keys/nonces are public fixtures and must never be used for real files.
import { createCipheriv, createECDH, createHash, createHmac } from 'node:crypto'

const concat = (...values) => Buffer.concat(values.map((value) => typeof value === 'string' ? Buffer.from(value) : value))
const hash = (bytes) => createHash('sha256').update(bytes).digest()
const hmac = (key, bytes) => createHmac('sha256', key).update(bytes).digest()
const empty = Buffer.alloc(0)
const u16 = (value) => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes }
const extract = (suite, salt, label, ikm) => hmac(salt, concat('HPKE-v1', suite, label, ikm))
const expand = (suite, prk, label, info, length) => {
  if (length > 32) throw new Error('Fixture only needs one SHA-256 HKDF expand block')
  return hmac(prk, concat(u16(length), 'HPKE-v1', suite, label, info, Buffer.from([1]))).subarray(0, length)
}
const encrypt = (key, nonce, aad, plaintext) => {
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  return concat(cipher.update(plaintext), cipher.final(), cipher.getAuthTag())
}
const keyPair = (scalar) => {
  const key = createECDH('prime256v1')
  const privateKey = Buffer.alloc(32)
  privateKey[31] = scalar
  key.setPrivateKey(privateKey)
  return key
}

export function referenceTeamEnvelope(payload, binding) {
  const sender = keyPair(1)
  const recipient = keyPair(2)
  const ephemeral = keyPair(3)
  const enc = ephemeral.getPublicKey()
  const kemSuite = concat('KEM', u16(16))
  const hpkeSuite = concat('HPKE', u16(16), u16(1), u16(2))
  const dh = concat(ephemeral.computeSecret(recipient.getPublicKey()), sender.computeSecret(recipient.getPublicKey()))
  const kemContext = concat(enc, recipient.getPublicKey(), sender.getPublicKey())
  const sharedSecret = expand(kemSuite, extract(kemSuite, empty, 'eae_prk', dh), 'shared_secret', kemContext, 32)
  const ids = [binding.organizationId, binding.projectId, binding.environmentId, binding.requestId,
    binding.transferId, binding.senderUserId, binding.senderDeviceId, binding.recipientUserId, binding.recipientDeviceId]
  const info = hash(JSON.stringify(['EnvHandoff team envelope v1', ...ids.map((id) => id.toLowerCase())]))
  const context = concat(Buffer.from([2]), extract(hpkeSuite, empty, 'psk_id_hash', empty), extract(hpkeSuite, empty, 'info_hash', info))
  const secret = extract(hpkeSuite, sharedSecret, 'secret', empty)
  const hpkeKey = expand(hpkeSuite, secret, 'key', context, 32)
  const hpkeNonce = expand(hpkeSuite, secret, 'base_nonce', context, 12)

  const bundleHeader = concat('ENVHANDOFF', u16(1), Buffer.alloc(12))
  const bundleKey = Buffer.alloc(32, 42)
  const bundle = concat(bundleHeader, encrypt(bundleKey, bundleHeader.subarray(12), bundleHeader, JSON.stringify(payload)))
  const header = concat('ENVHTEAM', u16(1))
  const wrappedCode = encrypt(hpkeKey, hpkeNonce, concat(header, hash(bundle)), bundleKey.toString('base64url'))
  const publicKey = recipient.getPublicKey()
  return {
    note: 'Public test-only vector, independently generated with Node crypto by team-reference.mjs. Never use these keys/nonces in production.',
    binding, payload,
    senderPublicKey: sender.getPublicKey().toString('hex'),
    recipientPrivateKey: {
      kty: 'EC', crv: 'P-256', ext: true, key_ops: ['deriveBits'],
      x: publicKey.subarray(1, 33).toString('base64url'),
      y: publicKey.subarray(33).toString('base64url'),
      d: recipient.getPrivateKey().toString('base64url'),
    },
    envelopeBase64: concat(header, enc, wrappedCode, bundle).toString('base64'),
  }
}

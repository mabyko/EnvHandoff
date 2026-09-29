import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core'

export type DeviceIdentity = { userId: string; deviceId: string; encryptionKey: string; signingKey: string }
export type DeviceAction = 'register' | 'approve' | 'revoke' | 'recover' | 'upload' | 'download' | 'ack'
export type DeviceChallenge = {
  id: string; action: DeviceAction; sessionHash: string
  actor: DeviceIdentity; target: DeviceIdentity; issuedAt: number; expiresAt: number
  scope?: { organizationId: string; requestId: string; transferId: string; digest: string }
}
export type EncryptedDeviceChallenge = { challenge: DeviceChallenge; enc: string; ciphertext: string }
const encoder = new TextEncoder()
const domain = 'EnvHandoff device proof v1'
const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() })
const signatureAlgorithm = { name: 'ECDSA', hash: 'SHA-256' }
export const DEVICE_CHALLENGE_MS = 5 * 60 * 1000

export function deviceId(value: string): string {
  if (typeof value !== 'string' || value.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error('Invalid device identifier')
  return value
}

export function encodeDeviceBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decode(value: string, size?: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid proof encoding')
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  if (encodeDeviceBytes(bytes) !== value || (size !== undefined && bytes.length !== size)) throw new Error('Invalid proof encoding')
  return bytes
}

export async function deviceHash(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  return encodeDeviceBytes(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value)))
}

function identityValues(identity: DeviceIdentity): string[] {
  if (!identity || Object.keys(identity).sort().join(',') !== 'deviceId,encryptionKey,signingKey,userId') throw new Error('Invalid device identity')
  for (const key of [identity.encryptionKey, identity.signingKey]) {
    if (decode(key, 65)[0] !== 4) throw new Error('Invalid public key')
  }
  return [deviceId(identity.userId), deviceId(identity.deviceId), identity.encryptionKey, identity.signingKey]
}

export async function importDevicePublicKey(value: string, purpose: 'ECDH' | 'ECDSA'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', decode(value, 65), { name: purpose, namedCurve: 'P-256' }, true, purpose === 'ECDSA' ? ['verify'] : [])
}

export async function deviceIdentity(userId: string, id: string, encryption: CryptoKey, signing: CryptoKey): Promise<DeviceIdentity> {
  const result = {
    userId: deviceId(userId), deviceId: deviceId(id),
    encryptionKey: encodeDeviceBytes(new Uint8Array(await crypto.subtle.exportKey('raw', encryption))),
    signingKey: encodeDeviceBytes(new Uint8Array(await crypto.subtle.exportKey('raw', signing))),
  }
  identityValues(result)
  return result
}

export async function identityFingerprint(identity: DeviceIdentity): Promise<string> {
  return deviceHash(JSON.stringify(['EnvHandoff device identity v1', ...identityValues(identity)]))
}

function challengeBytes(challenge: DeviceChallenge): Uint8Array<ArrayBuffer> {
  const scoped = challenge && ['upload', 'download', 'ack'].includes(challenge.action)
  const keys = scoped ? 'action,actor,expiresAt,id,issuedAt,scope,sessionHash,target' : 'action,actor,expiresAt,id,issuedAt,sessionHash,target'
  if (!challenge || Object.keys(challenge).sort().join(',') !== keys ||
      !['register', 'approve', 'revoke', 'recover', 'upload', 'download', 'ack'].includes(challenge.action) ||
      challenge.actor.userId !== challenge.target.userId ||
      !Number.isSafeInteger(challenge.issuedAt) || !Number.isSafeInteger(challenge.expiresAt) ||
      challenge.issuedAt < 0 || challenge.expiresAt - challenge.issuedAt !== DEVICE_CHALLENGE_MS) throw new Error('Invalid device challenge')
  decode(challenge.sessionHash, 32)
  const scope: string[] = []
  if (scoped) {
    const value = challenge.scope
    if (!value || Object.keys(value).sort().join(',') !== 'digest,organizationId,requestId,transferId' || JSON.stringify(challenge.actor) !== JSON.stringify(challenge.target)) throw new Error('Invalid transfer scope')
    decode(value.digest, 32)
    scope.push(deviceId(value.organizationId), deviceId(value.requestId), deviceId(value.transferId), value.digest)
  }
  return encoder.encode(JSON.stringify([domain, deviceId(challenge.id), challenge.action, challenge.sessionHash,
    identityValues(challenge.actor), identityValues(challenge.target), challenge.issuedAt, challenge.expiresAt, ...scope]))
}

const protectedHeader = encodeDeviceBytes(encoder.encode(JSON.stringify({ alg: 'ES256', typ: 'envhandoff-device-proof+jws' })))
const payload = (challenge: DeviceChallenge, secret: string) => encodeDeviceBytes(encoder.encode(JSON.stringify([
  domain, encodeDeviceBytes(challengeBytes(challenge)), secret,
])))

// The server keeps only the secret hash. Decrypting the secret proves ECDH key possession.
export async function encryptDeviceChallenge(challenge: DeviceChallenge): Promise<{ wire: EncryptedDeviceChallenge; secretHash: string }> {
  const snapshot: DeviceChallenge = structuredClone(challenge)
  const info = decode(await deviceHash(challengeBytes(snapshot)), 32)
  const secret = crypto.getRandomValues(new Uint8Array(32))
  try {
    const sender = await suite.createSenderContext({ recipientPublicKey: await importDevicePublicKey(snapshot.actor.encryptionKey, 'ECDH'), info })
    const ciphertext = await sender.seal(secret)
    return { wire: { challenge: snapshot, enc: encodeDeviceBytes(new Uint8Array(sender.enc)), ciphertext: encodeDeviceBytes(new Uint8Array(ciphertext)) }, secretHash: await deviceHash(secret) }
  } finally { secret.fill(0) }
}

// expected is constructed from the user's intended action/confirmed target, not copied from the wire.
export async function answerDeviceChallenge(wire: EncryptedDeviceChallenge, expected: DeviceChallenge, encryption: CryptoKeyPair, signing: CryptoKey, now = Date.now()): Promise<string> {
  const snapshot = structuredClone(expected)
  const bytes = challengeBytes(snapshot)
  if (encodeDeviceBytes(bytes) !== encodeDeviceBytes(challengeBytes(wire.challenge)) || now < snapshot.issuedAt || now >= snapshot.expiresAt) throw new Error('Unexpected or expired device challenge')
  const recipient = await suite.createRecipientContext({ recipientKey: encryption, enc: decode(wire.enc, 65), info: decode(await deviceHash(bytes), 32) })
  const secret = new Uint8Array(await recipient.open(decode(wire.ciphertext, 48)))
  try {
    const input = `${protectedHeader}.${payload(snapshot, encodeDeviceBytes(secret))}`
    const signature = await crypto.subtle.sign(signatureAlgorithm, signing, encoder.encode(input))
    return `${input}.${encodeDeviceBytes(new Uint8Array(signature))}`
  } finally { secret.fill(0) }
}

// Cryptographic verification only; the registry must atomically consume the challenge.
export async function verifyDeviceProof(challenge: DeviceChallenge, proof: string, secretHash: string): Promise<boolean> {
  try {
    if (typeof proof !== 'string' || proof.length > 4096) return false
    const [header, body, signature, extra] = proof.split('.')
    if (extra !== undefined || header !== protectedHeader) return false
    const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(body)))
    if (!Array.isArray(decoded) || decoded.length !== 3 || typeof decoded[2] !== 'string') return false
    if (body !== payload(challenge, decoded[2]) || await deviceHash(decode(decoded[2], 32)) !== secretHash) return false
    return await crypto.subtle.verify(signatureAlgorithm, await importDevicePublicKey(challenge.actor.signingKey, 'ECDSA'), decode(signature, 64), encoder.encode(`${header}.${body}`))
  } catch { return false }
}

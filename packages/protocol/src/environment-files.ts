import { deviceHash, deviceId, encodeDeviceBytes, identityValues, importDevicePublicKey } from './device-proof.ts'
import type { DeviceIdentity, PublicationAction } from './device-proof.ts'

export type UnsignedPublicationStatement = {
  organizationId: string; projectId: string; environmentId: string; versionId: string
  expectedGeneration: string; size: number; digest: string; publisher: DeviceIdentity
}
export type PublicationStatement = UnsignedPublicationStatement & { signature: string }
export type PublicationWrapInput = { recipientDeviceId: string; wrap: string }
export type EnvironmentVersion = PublicationStatement & {
  status: 'reserved' | 'writing' | 'committed' | 'failed' | 'cancelled'
  createdAt: number; publishedAt: number | null; endedAt: number | null; endReason: string | null
  publisherLogin: string; publisherActive: boolean
}
export type EnvironmentKeyGrant = {
  recipient: DeviceIdentity; wrapper: DeviceIdentity; wrap: string; wrapperActive: boolean
}
export type PublicationRecipient = { identity: DeviceIdentity; login: string; hasWrap: boolean }
export type EnvironmentFilesInfo = {
  sessionHash: string; permissions: { receive: boolean; send: boolean; externalShare: boolean }
  generation: string; endReason: string | null; latest: EnvironmentVersion | null
  access: 'empty' | 'available' | 'needs_grant' | 'no_device'
  wrap: EnvironmentKeyGrant | null; recipients: PublicationRecipient[]
}

const encoder = new TextEncoder()
export const PUBLICATION_WRAP_LIMIT = 100
export const PUBLICATION_WRAP_BYTES = 124
const signatureAlgorithm = { name: 'ECDSA', hash: 'SHA-256' }

function decode(value: string, size: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid publication encoding')
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))
  if (bytes.length !== size || encodeDeviceBytes(bytes) !== value) throw new Error('Invalid publication encoding')
  return bytes
}

export function validatePublicationWrap(value: string): string {
  if (decode(value, PUBLICATION_WRAP_BYTES)[0] !== 4) throw new Error('Invalid publication key wrap')
  return value
}

export function publicationStatementBytes(statement: UnsignedPublicationStatement): Uint8Array<ArrayBuffer> {
  if (!statement || !Number.isSafeInteger(statement.size) || statement.size < 40 || statement.size > 16 * 1024 * 1024) throw new Error('Invalid publication size')
  decode(statement.digest, 32)
  return encoder.encode(JSON.stringify(['EnvHandoff environment publication v1',
    deviceId(statement.organizationId), deviceId(statement.projectId), deviceId(statement.environmentId),
    deviceId(statement.versionId), deviceId(statement.expectedGeneration), statement.size, statement.digest,
    ...identityValues(statement.publisher),
  ]))
}

export async function signPublicationStatement(statement: UnsignedPublicationStatement, signingKey: CryptoKey): Promise<PublicationStatement> {
  const snapshot = structuredClone(statement)
  const signature = await crypto.subtle.sign(signatureAlgorithm, signingKey, publicationStatementBytes(snapshot))
  return { ...snapshot, signature: encodeDeviceBytes(new Uint8Array(signature)) }
}

export async function verifyPublicationStatement(statement: PublicationStatement): Promise<boolean> {
  try {
    const snapshot = structuredClone(statement)
    const bytes = publicationStatementBytes(snapshot), signature = decode(snapshot.signature, 64)
    return await crypto.subtle.verify(signatureAlgorithm, await importDevicePublicKey(snapshot.publisher.signingKey, 'ECDSA'), signature, bytes)
  } catch { return false }
}

export async function publicationStatementHash(statement: UnsignedPublicationStatement): Promise<string> {
  return deviceHash(publicationStatementBytes(statement))
}

export async function publicationPayloadDigest(action: PublicationAction, input: {
  signature?: string; wraps?: PublicationWrapInput[]; targetDeviceId?: string; wrap?: string
} = {}): Promise<string> {
  const values = structuredClone(input)
  let payload: unknown[]
  if (action === 'publication-upload') {
    if (Object.keys(values).sort().join(',') !== 'signature,wraps' || !Array.isArray(values.wraps) || !values.wraps.length || values.wraps.length > PUBLICATION_WRAP_LIMIT) throw new Error('Invalid publication upload intent')
    decode(values.signature!, 64)
    const wraps = values.wraps.map(item => {
      if (!item || Object.keys(item).sort().join(',') !== 'recipientDeviceId,wrap') throw new Error('Invalid publication recipient')
      return [deviceId(item.recipientDeviceId), validatePublicationWrap(item.wrap)]
    }).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    if (new Set(wraps.map(item => item[0])).size !== wraps.length) throw new Error('Duplicate publication recipient')
    payload = ['upload', values.signature, wraps]
  } else if (action === 'publication-grant') {
    if (Object.keys(values).sort().join(',') !== 'targetDeviceId,wrap') throw new Error('Invalid publication grant intent')
    payload = ['grant', deviceId(values.targetDeviceId!), validatePublicationWrap(values.wrap!)]
  } else if (action === 'publication-download' || action === 'publication-remove') {
    if (Object.keys(values).length) throw new Error('Unexpected publication intent fields')
    payload = [action === 'publication-download' ? 'download' : 'remove']
  } else throw new Error('Invalid publication action')
  return deviceHash(JSON.stringify(payload))
}

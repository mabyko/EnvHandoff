import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core'
import { BundleError, createBundle, LIMITS, openBundle } from './bundle.ts'
import type { OpenedBundle, SourceFile } from './bundle.ts'

// See docs/team-envelope-v1.md. Device registration/proofs remain a separate protocol.
const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
})
const encoder = new TextEncoder()
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const header = encoder.encode('ENVHTEAM\x00\x01')
const encOffset = header.length
const keyOffset = encOffset + 65
const bundleOffset = keyOffset + 59 // 43-byte v1 code plus the HPKE AEAD tag.

export type TeamBinding = {
  organizationId: string
  projectId: string
  environmentId: string
  requestId: string
  transferId: string
  senderUserId: string
  senderDeviceId: string
  recipientUserId: string
  recipientDeviceId: string
}

async function bindingBytes(binding: TeamBinding): Promise<Uint8Array<ArrayBuffer>> {
  const ids = [
    binding.organizationId, binding.projectId, binding.environmentId, binding.requestId,
    binding.transferId, binding.senderUserId, binding.senderDeviceId,
    binding.recipientUserId, binding.recipientDeviceId,
  ]
  if (ids.some((id) => typeof id !== 'string' || id.length !== 36 || !idPattern.test(id))) {
    throw new BundleError('BINDING', '팀 전달의 요청·기기 정보를 확인해주세요.')
  }
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(['EnvHandoff team envelope v1', ...ids.map((id) => id.toLowerCase())])))
  return new Uint8Array(digest)
}

async function bundleAad(bundle: ArrayBuffer): Promise<Uint8Array<ArrayBuffer>> {
  const aad = new Uint8Array(header.length + 32)
  aad.set(header)
  aad.set(new Uint8Array(await crypto.subtle.digest('SHA-256', bundle)), header.length)
  return aad
}

export async function generateDeviceKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
}

export async function deviceFingerprint(publicKey: CryptoKey): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await crypto.subtle.exportKey('raw', publicKey)))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').match(/.{1,4}/g)!.join(' ')
}

export async function sealTeamBundle(
  sources: SourceFile[], projectLabel: string, environment: string,
  binding: TeamBinding, senderKey: CryptoKeyPair, recipientPublicKey: CryptoKey,
): Promise<ArrayBuffer> {
  const info = await bindingBytes(binding)
  const bundle = await createBundle(sources, projectLabel, environment)
  const sender = await suite.createSenderContext({ recipientPublicKey, senderKey, info })
  const code = encoder.encode(bundle.code)
  try {
    const wrappedKey = await sender.seal(code, await bundleAad(bundle.bytes))
    const bytes = new Uint8Array(bundleOffset + bundle.bytes.byteLength)
    bytes.set(header)
    bytes.set(new Uint8Array(sender.enc), encOffset)
    bytes.set(new Uint8Array(wrappedKey), keyOffset)
    bytes.set(new Uint8Array(bundle.bytes), bundleOffset)
    return bytes.buffer
  } finally {
    code.fill(0)
    bundle.code = ''
  }
}

export async function openTeamBundle(
  envelope: ArrayBuffer, binding: TeamBinding, recipientKey: CryptoKeyPair, senderPublicKey: CryptoKey,
): Promise<OpenedBundle> {
  if (!(envelope instanceof ArrayBuffer) || envelope.byteLength < bundleOffset + 40) {
    throw new BundleError('FORMAT', '팀 전달 파일이 잘렸거나 올바른 형식이 아니에요.')
  }
  if (envelope.byteLength > bundleOffset + LIMITS.bundleBytes) {
    throw new BundleError('SIZE', '팀 전달 파일의 최대 크기를 넘었어요.')
  }
  // Snapshot before awaiting: authentication and parsing must use the same input bytes.
  const bytes = new Uint8Array(envelope.slice(0))
  if (!header.subarray(0, 8).every((value, index) => value === bytes[index])) {
    throw new BundleError('FORMAT', 'EnvHandoff 팀 전달 파일을 선택해주세요.')
  }
  if (new DataView(bytes.buffer).getUint16(8, false) !== 1) {
    throw new BundleError('VERSION', '지원하지 않는 팀 전달 파일 버전이에요.')
  }
  const info = await bindingBytes(binding)
  const bundle = bytes.slice(bundleOffset).buffer
  let code: Uint8Array<ArrayBuffer>
  try {
    const recipient = await suite.createRecipientContext({ recipientKey, senderPublicKey, enc: bytes.slice(encOffset, keyOffset), info })
    code = new Uint8Array(await recipient.open(bytes.slice(keyOffset, bundleOffset), await bundleAad(bundle)))
  } catch {
    throw new BundleError('AUTH', '팀 전달을 인증하지 못했어요. 요청과 확인한 기기를 다시 확인해주세요.')
  }
  try {
    return await openBundle(bundle, new TextDecoder('utf-8', { fatal: true }).decode(code))
  } finally { code.fill(0) }
}

import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core'
import { deviceHash, encodeDeviceBytes, identityValues } from '@envhandoff/protocol/device-proof'
import type { DeviceIdentity } from '@envhandoff/protocol/device-proof'
import { PUBLICATION_WRAP_BYTES, publicationStatementBytes, publicationStatementHash, validatePublicationWrap, verifyPublicationStatement } from '@envhandoff/protocol/environment-files'
import type { PublicationStatement, UnsignedPublicationStatement } from '@envhandoff/protocol/environment-files'
import { BundleError, createBundle, LIMITS, openBundle, validateFiles, validatePath } from './bundle.ts'
import type { BundleFile, OpenedBundle, SourceFile } from './bundle.ts'

// See docs/project-files-design.md. The published bundle is the unchanged v1 format;
// each recipient device receives a separate HPKE Auth wrap of its 43-byte code.
const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() })
const encoder = new TextEncoder()
const aadHeader = encoder.encode('ENVHENVK\x00\x01')
export const WRAP_LENGTH = 166
export const MIN_BUNDLE = 40

const fail = (code: string, message: string): never => { throw new BundleError(code, message) }

// Strict 124-byte enc65 || ciphertext59 wrap; the shared validator also rejects non-canonical Base64url.
function decodeWrap(value: string): Uint8Array<ArrayBuffer> {
  try { validatePublicationWrap(value) } catch { fail('WRAP', '키 전달 형식이 올바르지 않아요.') }
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
  if (value.length !== WRAP_LENGTH || bytes.length !== PUBLICATION_WRAP_BYTES) fail('WRAP', '키 전달 형식이 올바르지 않아요.')
  return bytes
}

const sha256 = async (bytes: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))

// info binds the statement hash and full wrapper/recipient identities; aad binds the statement bytes.
async function wrapContext(statement: UnsignedPublicationStatement, wrapper: DeviceIdentity, recipient: DeviceIdentity) {
  let values: string[], bytes: Uint8Array<ArrayBuffer>
  try { values = [...identityValues(wrapper), ...identityValues(recipient)] } catch { return fail('IDENTITY', '기기 정보 형식이 올바르지 않아요.') }
  try { bytes = publicationStatementBytes(statement) } catch { return fail('STATEMENT', '게시본 정보 형식이 올바르지 않아요.') }
  const info = await sha256(encoder.encode(JSON.stringify(['EnvHandoff environment key v1', await publicationStatementHash(statement), ...values])))
  const aad = new Uint8Array(aadHeader.length + 32)
  aad.set(aadHeader); aad.set(await sha256(bytes), aadHeader.length)
  return { info, aad }
}

export const sameIdentity = (a: DeviceIdentity | undefined, b: DeviceIdentity | undefined) => !!a && !!b &&
  a.userId === b.userId && a.deviceId === b.deviceId && a.encryptionKey === b.encryptionKey && a.signingKey === b.signingKey

export async function wrapEnvironmentKey(code: string, statement: UnsignedPublicationStatement, wrapper: DeviceIdentity, wrapperKeys: CryptoKeyPair, recipient: DeviceIdentity, recipientPublicKey: CryptoKey): Promise<string> {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) fail('CODE', '게시본 키 형식이 올바르지 않아요.')
  const { info, aad } = await wrapContext(statement, wrapper, recipient)
  const plaintext = encoder.encode(code)
  try {
    const sender = await suite.createSenderContext({ recipientPublicKey, senderKey: wrapperKeys, info })
    const ciphertext = new Uint8Array(await sender.seal(plaintext, aad))
    const bytes = new Uint8Array(PUBLICATION_WRAP_BYTES)
    bytes.set(new Uint8Array(sender.enc)); bytes.set(ciphertext, 65)
    return encodeDeviceBytes(bytes)
  } finally { plaintext.fill(0) }
}

// Returns the bundle code for opening or for an explicit key grant only. Never persist or log it.
export async function unwrapEnvironmentKey(wrap: string, statement: UnsignedPublicationStatement, wrapper: DeviceIdentity, wrapperPublicKey: CryptoKey, recipient: DeviceIdentity, recipientKeys: CryptoKeyPair): Promise<string> {
  const bytes = decodeWrap(wrap)
  const { info, aad } = await wrapContext(statement, wrapper, recipient)
  let code: Uint8Array<ArrayBuffer>
  try {
    const context = await suite.createRecipientContext({ recipientKey: recipientKeys, senderPublicKey: wrapperPublicKey, enc: bytes.slice(0, 65), info })
    code = new Uint8Array(await context.open(bytes.slice(65), aad))
  } catch { return fail('AUTH', '게시본 키를 열지 못했어요. 키를 제공한 기기와 게시본을 다시 확인해주세요.') }
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(code)
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) fail('AUTH', '게시본 키 형식이 올바르지 않아요.')
    return value
  } finally { code.fill(0) }
}

export async function sealEnvironmentBundle(sources: SourceFile[], project: string, environment: string) {
  const bundle = await createBundle(sources, project, environment)
  return { bytes: bundle.bytes, code: bundle.code, size: bundle.bytes.byteLength, digest: await deviceHash(new Uint8Array(bundle.bytes)) }
}

// Checks the publisher signature, scope, size and digest before authenticating the v1 bundle.
export async function openEnvironmentBundle(input: ArrayBuffer, statement: PublicationStatement, scope: { organizationId: string; projectId: string; environmentId: string }, code: string): Promise<OpenedBundle> {
  await assertStatement(statement, scope)
  const bytes = input.slice(0)
  if (bytes.byteLength !== statement.size) fail('SIZE', '게시본 크기가 서명과 달라요.')
  if (await deviceHash(new Uint8Array(bytes)) !== statement.digest) fail('DIGEST', '게시본 내용이 서명과 달라요.')
  return openBundle(bytes, code)
}

export async function assertStatement(statement: PublicationStatement, scope: { organizationId: string; projectId: string; environmentId: string }): Promise<void> {
  if (!statement || statement.organizationId !== scope.organizationId || statement.projectId !== scope.projectId || statement.environmentId !== scope.environmentId) fail('SCOPE', '다른 프로젝트·환경의 게시본이에요.')
  if (!Number.isSafeInteger(statement.size) || statement.size < MIN_BUNDLE || statement.size > LIMITS.bundleBytes) fail('SIZE', '게시본 크기가 지원 범위를 벗어났어요.')
  let valid = false
  try { valid = await verifyPublicationStatement(statement) } catch { /* Malformed statements are rejected below. */ }
  if (!valid) fail('SIGNATURE', '게시자 서명을 확인하지 못했어요.')
}

// Staged edits on top of the opened latest bundle. A missing file means delete.
export type DraftOp = { path: string; file?: File }
export type DraftRow = { path: string; kind: 'keep' | 'new' | 'replace' | 'delete'; size: number }
const key = (path: string) => path.normalize('NFKC').toUpperCase().toLowerCase()
const same = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((value, i) => value === b[i])

// Unchanged files keep their original bytes; the result is validated with the bundle rules.
export function planDraft(base: BundleFile[], ops: DraftOp[]): { rows: DraftRow[]; sources: SourceFile[] } {
  const seen = new Set<string>()
  const changes = new Map<string, DraftOp>()
  for (const op of ops) {
    const path = validatePath(op.path)
    if (seen.has(key(path))) fail('PATH', `${path} 경로를 두 번 변경했어요. 하나만 남겨주세요.`)
    seen.add(key(path))
    if (!op.file && !base.some(file => file.path === path)) fail('PATH', `${path} 파일이 최신 게시본에 없어요.`)
    changes.set(path, { ...op, path })
  }
  const rows: DraftRow[] = [], sources: SourceFile[] = []
  const name = (path: string) => path.split('/').at(-1)!
  for (const file of base) {
    const op = changes.get(file.path)
    changes.delete(file.path)
    if (op && !op.file) { rows.push({ path: file.path, kind: 'delete', size: file.bytes.byteLength }); continue }
    rows.push({ path: file.path, kind: op ? 'replace' : 'keep', size: op?.file?.size ?? file.bytes.byteLength })
    sources.push({ path: file.path, file: op?.file ?? new File([file.bytes], name(file.path)) })
  }
  for (const op of changes.values()) {
    rows.push({ path: op.path, kind: 'new', size: op.file!.size })
    sources.push({ path: op.path, file: op.file! })
  }
  if (sources.length) validateFiles(sources.map(source => ({ path: source.path, size: source.file.size })))
  return { rows, sources }
}

// Paths this draft touches that changed upstream between two opened bases.
export function upstreamChanges(previous: BundleFile[], latest: BundleFile[], ops: DraftOp[]): string[] {
  return ops.map(op => op.path).filter(path => {
    const before = previous.find(file => key(file.path) === key(path)), after = latest.find(file => key(file.path) === key(path))
    return !before !== !after || (!!before && !!after && (before.path !== after.path || !same(before.bytes, after.bytes)))
  })
}

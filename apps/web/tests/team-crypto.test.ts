import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { referenceTeamEnvelope } from '../../../fixtures/bundles/team-reference.mjs'
import { BundleError, LIMITS } from '../src/lib/bundle.ts'
import { deviceFingerprint, generateDeviceKey, openTeamBundle, sealTeamBundle } from '../src/lib/team-crypto.ts'
import type { TeamBinding } from '../src/lib/team-crypto.ts'

const vector = JSON.parse(readFileSync(new URL('../../../fixtures/bundles/team-v1.json', import.meta.url), 'utf8'))
const binding: TeamBinding = vector.binding
const bytes = (base64: string) => Uint8Array.from(Buffer.from(base64, 'base64')).buffer
const isError = (code: string) => (error: unknown) => error instanceof BundleError && error.code === code
const contents = [Buffer.from('\ufeffPUBLIC_TEST=value\r\n'), Buffer.from([0, 255, 128]), Buffer.alloc(0)]
const files = contents.map((content, i) => ({ file: new File([content], `example-${i}`), path: `config/example-${i}` }))
const seal = (sender: CryptoKeyPair, recipient: CryptoKeyPair, context = binding) =>
  sealTeamBundle(files, 'public-project', 'development', context, sender, recipient.publicKey)

test('team key wrapping preserves files and authenticates all IDs and both device keys', async () => {
  const sender = await generateDeviceKey(), recipient = await generateDeviceKey(), other = await generateDeviceKey()
  assert.equal(sender.privateKey.extractable, false)
  assert.equal(recipient.privateKey.extractable, false)
  assert.notEqual(await deviceFingerprint(sender.publicKey), await deviceFingerprint(other.publicKey))
  const envelope = await seal(sender, recipient)
  const opened = await openTeamBundle(envelope, binding, recipient, sender.publicKey)
  assert.equal(opened.projectLabel, 'public-project')
  opened.files.forEach((file, i) => {
    assert.equal(file.path, files[i].path)
    assert.deepEqual(Buffer.from(file.bytes), contents[i])
  })
  assert.equal(Buffer.from(envelope).includes(Buffer.from('PUBLIC_TEST')), false)
  assert.equal(Buffer.from(envelope).includes(Buffer.from('public-project')), false)
  assert.notDeepEqual(envelope, await seal(sender, recipient))
  for (const key of Object.keys(binding) as (keyof TeamBinding)[]) {
    await assert.rejects(openTeamBundle(envelope, { ...binding, [key]: crypto.randomUUID() }, recipient, sender.publicKey), isError('AUTH'))
  }
  const reordered = Object.fromEntries(Object.entries(binding).reverse().map(([key, value]) => [key, value.toUpperCase()])) as TeamBinding
  assert.deepEqual(await openTeamBundle(envelope, reordered, recipient, sender.publicKey), opened)
  await assert.rejects(openTeamBundle(envelope, binding, other, sender.publicKey), isError('AUTH'))
  await assert.rejects(openTeamBundle(envelope, binding, recipient, other.publicKey), isError('AUTH'))
  await assert.rejects(seal(sender, recipient, { ...binding, requestId: 'invalid' }), isError('BINDING'))
  await assert.rejects(seal(sender, recipient, { ...binding, requestId: binding.requestId + '\n' }), isError('BINDING'))
})

test('rejects bad framing, changed keys/files, spliced bundles and excessive size', async () => {
  const sender = await generateDeviceKey(), recipient = await generateDeviceKey()
  const envelope = await seal(sender, recipient)
  const open = (input: ArrayBuffer) => openTeamBundle(input, binding, recipient, sender.publicKey)
  for (const [offset, code] of [[0, 'FORMAT'], [9, 'VERSION'], [10, 'AUTH'], [74, 'AUTH'], [75, 'AUTH'], [133, 'AUTH'], [134, 'AUTH'], [envelope.byteLength - 1, 'AUTH']] as const) {
    const changed = envelope.slice(0)
    new Uint8Array(changed)[offset] ^= 1
    await assert.rejects(open(changed), isError(code))
  }
  await assert.rejects(open(envelope.slice(0, 173)), isError('FORMAT'))
  await assert.rejects(open(envelope.slice(0, -1)), isError('AUTH'))
  await assert.rejects(open(new ArrayBuffer(134 + LIMITS.bundleBytes + 1)), isError('SIZE'))
  const second = new Uint8Array(await seal(sender, recipient))
  second.set(new Uint8Array(envelope).subarray(0, 134))
  await assert.rejects(open(second.buffer), isError('AUTH'))
  const mutable = envelope.slice(0)
  const pending = open(mutable)
  new Uint8Array(mutable).fill(0)
  assert.equal((await pending).files.length, files.length)
})

test('opens an independent public vector and rejects authenticated unsafe paths', async () => {
  assert.deepEqual(referenceTeamEnvelope(vector.payload, binding), vector)
  const algorithm = { name: 'ECDH', namedCurve: 'P-256' }
  const sender = await crypto.subtle.importKey('raw', Buffer.from(vector.senderPublicKey, 'hex'), algorithm, true, [])
  const privateKey = await crypto.subtle.importKey('jwk', vector.recipientPrivateKey, algorithm, false, ['deriveBits'])
  const publicKey = await crypto.subtle.importKey('jwk', { ...vector.recipientPrivateKey, d: undefined, key_ops: [] }, algorithm, true, [])
  const recipient = { privateKey, publicKey }
  const opened = await openTeamBundle(bytes(vector.envelopeBase64), binding, recipient, sender)
  assert.deepEqual(opened.files.map((file) => ({ path: file.path, contentBase64: Buffer.from(file.bytes).toString('base64') })), vector.payload.files)
  const malformed = referenceTeamEnvelope({ ...vector.payload, files: [{ path: '../.env', contentBase64: 'WA==' }] }, binding)
  await assert.rejects(openTeamBundle(bytes(malformed.envelopeBase64), binding, recipient, sender), isError('PATH'))
  await assert.rejects(sealTeamBundle([{ file: new File(['dummy'], '.env'), path: '../.env' }], 'test', 'dev', binding, await generateDeviceKey(), publicKey), isError('PATH'))
})

test('retains the maximum file count and total-byte boundary', async () => {
  const sender = await generateDeviceKey(), recipient = await generateDeviceKey()
  const largeFiles = Array.from({ length: LIMITS.files }, (_, i) => ({
    file: new File([new Uint8Array(i < 10 ? LIMITS.fileBytes : 0)], `file-${i}`), path: `file-${i}`,
  }))
  const envelope = await sealTeamBundle(largeFiles, 'boundary', 'development', binding, sender, recipient.publicKey)
  assert.ok(envelope.byteLength <= LIMITS.bundleBytes + 134)
  const opened = await openTeamBundle(envelope, binding, recipient, sender.publicKey)
  assert.equal(opened.files.length, LIMITS.files)
  assert.equal(opened.files.reduce((total, file) => total + file.bytes.byteLength, 0), LIMITS.totalBytes)
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { referenceEnvironmentPublication } from '../../../fixtures/bundles/environment-reference.mjs'
import { deviceIdentity } from '@envhandoff/protocol/device-proof'
import type { DeviceIdentity } from '@envhandoff/protocol/device-proof'
import { signPublicationStatement, verifyPublicationStatement } from '@envhandoff/protocol/environment-files'
import type { PublicationStatement } from '@envhandoff/protocol/environment-files'
import { BundleError } from '../src/lib/bundle.ts'
import { openEnvironmentBundle, planDraft, sealEnvironmentBundle, unwrapEnvironmentKey, upstreamChanges, WRAP_LENGTH, wrapEnvironmentKey } from '../src/lib/environment-keys.ts'

const vector = JSON.parse(readFileSync(new URL('../../../fixtures/bundles/environment-v1.json', import.meta.url), 'utf8'))
const isError = (code: string) => (error: unknown) => error instanceof BundleError && error.code === code
const uuid = () => crypto.randomUUID()
const scope = { organizationId: uuid(), projectId: uuid(), environmentId: uuid() }
type Device = { identity: DeviceIdentity; keys: CryptoKeyPair; signing: CryptoKeyPair }
async function device(userId = uuid()): Promise<Device> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  return { identity: await deviceIdentity(userId, uuid(), keys.publicKey, signing.publicKey), keys, signing }
}
const contents = [Buffer.from('﻿PUBLIC_TEST=value\r\n'), Buffer.from([0, 255, 128]), Buffer.alloc(0)]
const sources = contents.map((content, i) => ({ file: new File([content], `example-${i}`), path: `config/example-${i}` }))
async function publish(publisher: Device) {
  const sealed = await sealEnvironmentBundle(sources, 'public-project', 'development')
  const statement = await signPublicationStatement({ ...scope, versionId: uuid(), expectedGeneration: uuid(), size: sealed.size, digest: sealed.digest, publisher: publisher.identity }, publisher.signing.privateKey)
  return { sealed, statement }
}

test('wrap binds statement and full wrapper/recipient identities, and opens original bytes', async () => {
  const publisher = await device(), recipient = await device(), other = await device()
  const { sealed, statement } = await publish(publisher)
  const wrap = await wrapEnvironmentKey(sealed.code, statement, publisher.identity, publisher.keys, recipient.identity, recipient.keys.publicKey)
  assert.equal(wrap.length, WRAP_LENGTH)
  const code = await unwrapEnvironmentKey(wrap, statement, publisher.identity, publisher.keys.publicKey, recipient.identity, recipient.keys)
  const opened = await openEnvironmentBundle(sealed.bytes, statement, scope, code)
  opened.files.forEach((file, i) => { assert.equal(file.path, sources[i].path); assert.deepEqual(Buffer.from(file.bytes), contents[i]) })
  assert.equal(Buffer.from(sealed.bytes).includes(Buffer.from('PUBLIC_TEST')), false)

  const unwrap = (s: PublicationStatement, w = publisher.identity, r = recipient.identity, wk = publisher.keys.publicKey, rk = recipient.keys) => unwrapEnvironmentKey(wrap, s, w, wk, r, rk)
  for (const [key, value] of [['organizationId', uuid()], ['projectId', uuid()], ['environmentId', uuid()], ['versionId', uuid()], ['expectedGeneration', uuid()], ['size', statement.size + 1], ['digest', Buffer.alloc(32, 1).toString('base64url')]] as const) {
    await assert.rejects(unwrap({ ...statement, [key]: value }), isError('AUTH'), key)
  }
  await assert.rejects(unwrap({ ...statement, publisher: other.identity }), isError('AUTH'))
  for (const key of ['userId', 'deviceId', 'signingKey'] as const) {
    await assert.rejects(unwrap(statement, { ...publisher.identity, [key]: other.identity[key] }), isError('AUTH'), 'wrapper ' + key)
    await assert.rejects(unwrap(statement, publisher.identity, { ...recipient.identity, [key]: other.identity[key] }), isError('AUTH'), 'recipient ' + key)
  }
  await assert.rejects(unwrap(statement, publisher.identity, recipient.identity, other.keys.publicKey), isError('AUTH'))
  await assert.rejects(unwrap(statement, publisher.identity, recipient.identity, publisher.keys.publicKey, other.keys), isError('AUTH'))
  // Swapping wrapper and recipient roles must not open either.
  await assert.rejects(unwrap(statement, recipient.identity, publisher.identity, recipient.keys.publicKey, publisher.keys), isError('AUTH'))
})

test('rejects malformed, resized and tampered wraps', async () => {
  const publisher = await device(), recipient = await device()
  const { sealed, statement } = await publish(publisher)
  const wrap = await wrapEnvironmentKey(sealed.code, statement, publisher.identity, publisher.keys, recipient.identity, recipient.keys.publicKey)
  const open = (value: string) => unwrapEnvironmentKey(value, statement, publisher.identity, publisher.keys.publicKey, recipient.identity, recipient.keys)
  for (const value of [wrap.slice(0, -1), wrap + 'A', wrap.slice(0, -1) + '=', 'A'.repeat(WRAP_LENGTH), wrap.replace(/.$/, c => c === 'A' ? 'B' : 'A').replace(/^./, '+')]) {
    await assert.rejects(open(value), isError('WRAP'))
  }
  const bytes = Buffer.from(wrap, 'base64url')
  for (const offset of [1, 64, 65, 100, 123]) {
    const changed = Buffer.from(bytes); changed[offset] ^= 1
    await assert.rejects(open(changed.toString('base64url')), (error: unknown) => isError('AUTH')(error) || isError('WRAP')(error))
  }
  await assert.rejects(wrapEnvironmentKey('short', statement, publisher.identity, publisher.keys, recipient.identity, recipient.keys.publicKey), isError('CODE'))
})

test('opening requires signature, scope, exact size and digest before v1 authentication', async () => {
  const publisher = await device(), other = await device()
  const { sealed, statement } = await publish(publisher)
  const open = (bytes: ArrayBuffer, s: PublicationStatement = statement, sc = scope) => openEnvironmentBundle(bytes, s, sc, sealed.code)
  await assert.rejects(open(sealed.bytes, { ...statement, publisher: other.identity }), isError('SIGNATURE'))
  await assert.rejects(open(sealed.bytes, { ...statement, signature: statement.signature.replace(/^./, c => c === 'A' ? 'B' : 'A') }), isError('SIGNATURE'))
  await assert.rejects(open(sealed.bytes, statement, { ...scope, environmentId: uuid() }), isError('SCOPE'))
  await assert.rejects(open(sealed.bytes.slice(0, -1)), isError('SIZE'))
  const changed = sealed.bytes.slice(0); new Uint8Array(changed)[30] ^= 1
  await assert.rejects(open(changed), isError('DIGEST'))
  await assert.rejects(openEnvironmentBundle(sealed.bytes, statement, scope, 'A'.repeat(43)), isError('AUTH'))
})

test('independent reference vector verifies, unwraps and rejects authenticated unsafe paths', async () => {
  assert.deepEqual(referenceEnvironmentPublication(vector.payload, vector.ids, vector.statement.signature), vector)
  assert.equal(await verifyPublicationStatement(vector.statement), true)
  const algorithm = { name: 'ECDH', namedCurve: 'P-256' }
  const privateKey = await crypto.subtle.importKey('jwk', vector.recipientPrivateKey, algorithm, false, ['deriveBits'])
  const publicKey = await crypto.subtle.importKey('jwk', { ...vector.recipientPrivateKey, d: undefined, key_ops: [] }, algorithm, true, [])
  const wrapper = await crypto.subtle.importKey('raw', Buffer.from(vector.statement.publisher.encryptionKey, 'base64url'), algorithm, true, [])
  const scope = { organizationId: vector.ids.organizationId, projectId: vector.ids.projectId, environmentId: vector.ids.environmentId }
  const code = await unwrapEnvironmentKey(vector.wrap, vector.statement, vector.statement.publisher, wrapper, vector.recipient, { privateKey, publicKey })
  const bundle = Uint8Array.from(Buffer.from(vector.bundleBase64, 'base64')).buffer
  const opened = await openEnvironmentBundle(bundle, vector.statement, scope, code)
  assert.deepEqual(opened.files.map(file => ({ path: file.path, contentBase64: Buffer.from(file.bytes).toString('base64') })), vector.payload.files)
  const unsafe = referenceEnvironmentPublication({ ...vector.payload, files: [{ path: '../.env', contentBase64: 'WA==' }] }, vector.ids)
  const unsafeCode = await unwrapEnvironmentKey(unsafe.wrap, unsafe.statement, unsafe.statement.publisher, wrapper, unsafe.recipient, { privateKey, publicKey })
  await assert.rejects(openEnvironmentBundle(Uint8Array.from(Buffer.from(unsafe.bundleBase64, 'base64')).buffer, unsafe.statement, scope, unsafeCode), isError('PATH'))
})

test('draft plan keeps unchanged bytes, labels edits and blocks unsafe or overlapping paths', async () => {
  const base = [{ path: '.env', bytes: new Uint8Array([1, 2, 3]) }, { path: 'config/app.env', bytes: new Uint8Array([0, 255]) }]
  const plan = planDraft(base, [{ path: 'config/app.env', file: new File(['new'], 'app.env') }, { path: 'apps/web/.env.local', file: new File(['x'], '.env.local') }])
  assert.deepEqual(plan.rows.map(row => [row.path, row.kind]), [['.env', 'keep'], ['config/app.env', 'replace'], ['apps/web/.env.local', 'new']])
  assert.deepEqual(new Uint8Array(await plan.sources[0].file.arrayBuffer()), base[0].bytes)
  assert.equal(await plan.sources[1].file.text(), 'new')
  assert.deepEqual(planDraft(base, [{ path: '.env' }]).rows.map(row => row.kind), ['delete', 'keep'])
  assert.equal(planDraft(base, [{ path: '.env' }, { path: 'config/app.env' }]).sources.length, 0)
  const file = new File(['x'], 'x')
  for (const ops of [[{ path: '../.env', file }], [{ path: '.git/config', file }], [{ path: '/abs', file }], [{ path: 'CONFIG/app.env', file }],
    [{ path: '.env/child', file }], [{ path: 'a', file }, { path: 'A', file }], [{ path: 'missing' }], [{ path: '.env', file }, { path: '.env' }]]) {
    assert.throws(() => planDraft(base, ops), isError('PATH'), JSON.stringify(ops.map(op => op.path)))
  }
  assert.throws(() => planDraft([], [{ path: 'big', file: new File([new Uint8Array(1024 * 1024 + 1)], 'big') }]), isError('SIZE'))
  const latest = [{ path: '.env', bytes: new Uint8Array([9]) }, base[1]]
  assert.deepEqual(upstreamChanges(base, latest, [{ path: '.env', file }, { path: 'config/app.env' }, { path: 'new', file }]), ['.env'])
  assert.deepEqual(upstreamChanges(base, [base[1]], [{ path: '.env' }]), ['.env'])
})

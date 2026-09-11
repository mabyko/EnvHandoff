import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { BundleError, createBundle, LIMITS, openBundle, validateFiles } from '../src/lib/bundle.ts'
import { previewText } from '../src/lib/files.ts'

const fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/bundles/v1.json', import.meta.url), 'utf8'),
)
const buffer = (bytes: Uint8Array): ArrayBuffer => Uint8Array.from(bytes).buffer
const isError = (code: string) => (error: unknown) => error instanceof BundleError && error.code === code

// Independent Node cipher implementation also creates authenticated malformed input.
function referenceEnvelope(payload: unknown): ArrayBuffer {
  const header = Buffer.from(fixture.headerHex, 'hex')
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(fixture.code, 'base64url'), header.subarray(12))
  cipher.setAAD(header)
  return buffer(
    Buffer.concat([header, cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]),
  )
}

test('opens the independent, public v1 interoperability vector', async () => {
  assert.deepEqual(buffer(Buffer.from(fixture.bundleBase64, 'base64')), referenceEnvelope(fixture.payload))
  const result = await openBundle(buffer(Buffer.from(fixture.bundleBase64, 'base64')), fixture.code)
  assert.equal(result.projectLabel, fixture.payload.projectLabel)
  assert.deepEqual(
    result.files.map((file) => ({
      path: file.path,
      contentBase64: Buffer.from(file.bytes).toString('base64'),
    })),
    fixture.payload.files,
  )
})

test('round-trips original bytes including CRLF, BOM, empty files, and binary content', async () => {
  const contents = [
    Buffer.from('\ufeff# public fixture\r\nDEMO_VALUE=hello\r\n'),
    Buffer.from([0, 255, 128, 13, 10]),
    Buffer.alloc(0),
  ]
  const sources = contents.map((content, i) => ({
    file: new File([content], `example-${i}`),
    path: `config/example-${i}`,
  }))
  const sealed = await createBundle(sources, 'sample-app', 'development')
  const result = await openBundle(sealed.bytes, ` ${sealed.code}\n`)
  assert.equal(sealed.code.length, 43)
  assert.equal(sealed.fileCount, 3)
  assert.equal(sealed.filename.includes('sample-app'), false)
  assert.equal(result.environment, 'development')
  result.files.forEach((file, i) => assert.deepEqual(Buffer.from(file.bytes), contents[i]))
  assert.equal(Buffer.from(sealed.bytes).includes(Buffer.from('sample-app')), false)
  const next = await createBundle(sources, 'sample-app', 'development')
  assert.notEqual(next.code, sealed.code)
  assert.notDeepEqual(next.bytes, sealed.bytes)
})

test('rejects wrong keys, modified nonce/ciphertext/tag, truncation, and unknown versions', async () => {
  const original = Buffer.from(fixture.bundleBase64, 'base64')
  await assert.rejects(openBundle(buffer(original), 'invalid'), isError('CODE'))
  await assert.rejects(
    openBundle(buffer(original), Buffer.alloc(32, 99).toString('base64url')),
    isError('AUTH'),
  )
  for (const index of [12, 24, original.length - 1]) {
    const changed = Buffer.from(original)
    changed[index] ^= 1
    await assert.rejects(openBundle(buffer(changed), fixture.code), isError('AUTH'))
  }
  await assert.rejects(openBundle(buffer(original.subarray(0, 20)), fixture.code), isError('FORMAT'))
  await assert.rejects(openBundle(buffer(original.subarray(0, -1)), fixture.code), isError('AUTH'))
  const version = Buffer.from(original)
  version[11] = 2
  await assert.rejects(openBundle(buffer(version), fixture.code), isError('VERSION'))
  await assert.rejects(openBundle(new ArrayBuffer(LIMITS.bundleBytes + 1), fixture.code), isError('SIZE'))
})

test('reports non-canonical share codes as code errors', async () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const last = alphabet.indexOf(fixture.code.at(-1))
  const nonCanonical = fixture.code.slice(0, -1) + alphabet[last + 1]
  assert.deepEqual(Buffer.from(nonCanonical, 'base64url'), Buffer.from(fixture.code, 'base64url'))
  await assert.rejects(
    openBundle(buffer(Buffer.from(fixture.bundleBase64, 'base64')), nonCanonical),
    isError('CODE'),
  )
})

test('enforces portable paths and collisions during creation and authenticated import', async () => {
  const invalid = [
    '/etc/config',
    '../config',
    'a/../b',
    'a//b',
    '.git/config',
    'a/.GIT/config',
    'C:/file',
    'a\\b',
    'CON.txt',
    'COM¹',
    'a:stream',
    'a.',
    'a ',
    'a/．．/b',
    'a\u202eb',
  ]
  for (const path of invalid) {
    assert.throws(() => validateFiles([{ path, size: 1 }]), isError('PATH'))
    await assert.rejects(
      openBundle(
        referenceEnvelope({ ...fixture.payload, files: [{ path, contentBase64: 'YQ==' }] }),
        fixture.code,
      ),
      isError('PATH'),
    )
  }
  for (const paths of [
    ['.env', '.ENV'],
    ['é', 'e\u0301'],
    ['a', 'a-b', 'a/b'],
    ['a', 'a/b'],
  ]) {
    assert.throws(() => validateFiles(paths.map((path) => ({ path, size: 1 }))), isError('PATH'))
    await assert.rejects(
      openBundle(
        referenceEnvelope({
          ...fixture.payload,
          files: paths.map((path) => ({ path, contentBase64: 'YQ==' })),
        }),
        fixture.code,
      ),
      isError('PATH'),
    )
  }
  assert.deepEqual(validateFiles([{ path: '환경/개발.env', size: 0 }]), ['환경/개발.env'])
})

test('rejects excessive sizes and malformed authenticated payloads', async () => {
  assert.throws(() => validateFiles([]), isError('SIZE'))
  assert.throws(
    () => validateFiles(Array.from({ length: 101 }, (_, i) => ({ path: `${i}`, size: 0 }))),
    isError('SIZE'),
  )
  assert.throws(() => validateFiles([{ path: '.env', size: LIMITS.fileBytes + 1 }]), isError('SIZE'))
  assert.throws(
    () => validateFiles(Array.from({ length: 11 }, (_, i) => ({ path: `${i}`, size: LIMITS.fileBytes }))),
    isError('SIZE'),
  )
  await assert.rejects(
    createBundle([{ path: '.env', file: new File(['a'], '.env') }], '', 'development'),
    isError('FORMAT'),
  )
  const malformed = [
    null,
    {},
    { ...fixture.payload, extra: true },
    { ...fixture.payload, formatVersion: 2 },
    { ...fixture.payload, createdAt: 'yesterday' },
    { ...fixture.payload, files: [{ path: '.env', contentBase64: 'YQ=' }] },
    { ...fixture.payload, files: [{ path: '.env', contentBase64: 'YR==' }] },
  ]
  for (const payload of malformed)
    await assert.rejects(
      openBundle(referenceEnvelope(payload), fixture.code),
      (error) => error instanceof BundleError,
    )
})

test('previews text without interpreting markup, bounds large previews, and identifies binary data', () => {
  const markup = '<script>alert("public example")</script>'
  assert.equal(previewText(new TextEncoder().encode(markup))?.text, markup)
  assert.equal(previewText(Uint8Array.from([0xff])), null)
  assert.equal(previewText(Uint8Array.from([0, 65])), null)
  const preview = previewText(new TextEncoder().encode('a'.repeat(20000)))
  assert.equal(preview?.text.length, 16384)
  assert.equal(preview?.truncated, true)
})

test('round-trips the allowed size and file-count boundaries', async () => {
  const content = new Uint8Array(LIMITS.fileBytes).fill(0xa5)
  const sources = Array.from({ length: 100 }, (_, i) => ({
    path: `config/${i}`,
    file: new File([i < 10 ? content : new Uint8Array(0)], `${i}`),
  }))
  const sealed = await createBundle(sources, 'public maximum-size fixture', 'test')
  assert(sealed.bytes.byteLength <= LIMITS.bundleBytes)
  const opened = await openBundle(sealed.bytes, sealed.code)
  assert.equal(opened.files.length, 100)
  assert.equal(
    opened.files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
    LIMITS.totalBytes,
  )
  for (const file of opened.files.slice(0, 10)) assert.deepEqual(file.bytes, content)
})

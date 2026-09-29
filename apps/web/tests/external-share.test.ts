import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createShareToken, hashShareToken, readExternalShare, readSharedBundle } from '../src/lib/external-share.ts'
import { createBundle, LIMITS } from '../src/lib/bundle.ts'
import { deviceHash } from '@envhandoff/protocol/device-proof'

test('external links accept only their UUID path and one canonical 256-bit token, separate from relay links', async () => {
  const id = crypto.randomUUID(), token = createShareToken(), path = `/receive/${id}`
  assert.equal(token.length, 43)
  assert.notEqual(token, createShareToken())
  assert.deepEqual(readExternalShare(path, '#token=' + token), { id, token })
  assert.equal(await hashShareToken(token), await deviceHash(new TextEncoder().encode(token)))
  for (const [pathname, hash] of [
    ['/', '#receive/' + token], ['/pro', '#token=' + token], ['/receive/not-a-uuid', '#token=' + token],
    [path, ''], [path, '#token=' + token + '&token=' + token], [path, '#token=' + token + '&code=secret'],
    [path, '#token=' + 'A'.repeat(42) + 'B'], [path, '#token=' + 'A'.repeat(42)],
    [path + '/content', '#token=' + token],
  ]) assert.equal(readExternalShare(pathname, hash), null)
})

test('a shared bundle returns plaintext only after exact length, digest, AEAD and full bundle validation', async () => {
  const original = new Uint8Array([0xef, 0xbb, 0xbf, 65, 61, 49, 13, 10])
  const bundle = await createBundle([{ file: new File([original], '.env'), path: 'config/.env' }], 'Example', 'test')
  const digest = await deviceHash(new Uint8Array(bundle.bytes)), signal = new AbortController().signal
  const opened = await readSharedBundle(new Response(bundle.bytes), bundle.bytes.byteLength, digest, bundle.code, signal)
  assert.deepEqual(opened.files[0].bytes, original)
  await assert.rejects(readSharedBundle(new Response(bundle.bytes), bundle.bytes.byteLength - 1, digest, bundle.code, signal))
  await assert.rejects(readSharedBundle(new Response(bundle.bytes.slice(0, -1)), bundle.bytes.byteLength, digest, bundle.code, signal))
  await assert.rejects(readSharedBundle(new Response(bundle.bytes), LIMITS.bundleBytes + 1, digest, bundle.code, signal))
  await assert.rejects(readSharedBundle(new Response(bundle.bytes), bundle.bytes.byteLength, digest, createShareToken(), signal))
  const changed = new Uint8Array(bundle.bytes.slice(0)); changed[changed.length - 1] ^= 1
  await assert.rejects(readSharedBundle(new Response(changed), changed.byteLength, digest, bundle.code, signal))
  await assert.rejects(readSharedBundle(new Response(changed), changed.byteLength, await deviceHash(changed), bundle.code, signal))
  await assert.rejects(readSharedBundle(new Response(bundle.bytes), bundle.bytes.byteLength, digest, bundle.code, AbortSignal.abort()))
})

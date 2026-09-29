import assert from 'node:assert/strict'
import { test } from 'node:test'
import { limitMessage, subscribeTabReturn, uploadEncrypted } from '../src/lib/pro-feedback.ts'

test('quota errors identify the reset time or release condition without promising a retention extension', () => {
  assert.match(limitMessage('request_rate_limit', null), /10분/)
  assert.match(limitMessage('download_limit', null), /UTC 00:00/)
  assert.match(limitMessage('storage_limit', null), /저장소 삭제가 끝나야/)
  assert.match(limitMessage('request_limit', null), /완료하거나 취소한 뒤/)
  assert.match(limitMessage('anything', '60'), /1분 뒤/)
  assert.match(limitMessage('anything', 'Thu, 01 Jan 1970 00:05:00 GMT', 0), /5분 뒤/)
  assert.match(limitMessage('share_rate_limit', '-100'), /1분 뒤/)
})

test('tab return observes focus and visibility and removes both listeners on cleanup', () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window'), documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const browser = new EventTarget(), page = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: page })
    let count = 0
    const stop = subscribeTabReturn(() => count++)
    page.dispatchEvent(new Event('visibilitychange')); assert.equal(count, 0)
    browser.dispatchEvent(new Event('focus')); assert.equal(count, 1)
    page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange')); assert.equal(count, 2)
    stop(); browser.dispatchEvent(new Event('focus')); page.dispatchEvent(new Event('visibilitychange')); assert.equal(count, 2)
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor); else Reflect.deleteProperty(globalThis, 'window')
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor); else Reflect.deleteProperty(globalThis, 'document')
  }
})

test('encrypted upload reports bounded progress, preserves headers/bytes, aborts, and surfaces uncertain failures', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest')
  class MockUpload {
    static last: MockUpload
    upload = { onprogress: (_event: { lengthComputable: boolean; loaded: number; total: number }) => {} }
    onload = () => {}; onloadend = () => {}; onabort = () => {}; onerror = () => {}; ontimeout = () => {}
    status = 200; responseText = ''; headers: Record<string, string> = {}; body: ArrayBuffer | null = null; withCredentials = false; timeout = 0
    constructor() { MockUpload.last = this }
    open(method: string, url: string) { assert.equal(method, 'POST'); assert.equal(url, '/upload') }
    setRequestHeader(name: string, value: string) { this.headers[name] = value }
    getResponseHeader() { return '60' }
    send(body: ArrayBuffer) { this.body = body }
    abort() { this.onabort(); this.onloadend() }
  }
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: MockUpload })
  try {
    const bytes = new Uint8Array([1, 2, 3]).buffer, updates: number[] = [], controller = new AbortController()
    const result = uploadEncrypted('/upload', bytes, { 'x-csrf-token': 'test-only' }, controller.signal, value => updates.push(value))
    const xhr = MockUpload.last
    assert.equal(xhr.withCredentials, true); assert.equal(xhr.body, bytes); assert.equal(xhr.headers['x-csrf-token'], 'test-only')
    xhr.upload.onprogress({ lengthComputable: true, loaded: 1, total: 2 }); xhr.upload.onprogress({ lengthComputable: true, loaded: 2, total: 2 })
    assert.deepEqual(updates, [50, 99]); xhr.onload(); xhr.onloadend(); await result
    const cancelled = new AbortController(), aborting = uploadEncrypted('/upload', bytes, {}, cancelled.signal, () => {})
    cancelled.abort(); await assert.rejects(aborting, { name: 'AbortError' })
    const failed = uploadEncrypted('/upload', bytes, {}, new AbortController().signal, () => {})
    MockUpload.last.onerror(); MockUpload.last.onloadend(); await assert.rejects(failed, /업로드 상태를 확인/)
    const limited = uploadEncrypted('/upload', bytes, {}, new AbortController().signal, () => {})
    MockUpload.last.status = 429; MockUpload.last.onload(); MockUpload.last.onloadend(); await assert.rejects(limited, /1분 뒤/)
    await assert.rejects(uploadEncrypted('/upload', bytes, {}, AbortSignal.abort(), () => {}), { name: 'AbortError' })
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'XMLHttpRequest', descriptor); else Reflect.deleteProperty(globalThis, 'XMLHttpRequest')
  }
})

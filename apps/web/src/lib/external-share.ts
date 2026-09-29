import { deviceHash } from '@envhandoff/protocol/device-proof'
import { LIMITS, openBundle } from './bundle.ts'

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
export const createShareToken = () => encode(crypto.getRandomValues(new Uint8Array(32)))
export const hashShareToken = (token: string) => deviceHash(new TextEncoder().encode(token))

export function readExternalShare(pathname: string, hash: string): { id: string; token: string } | null {
  const path = new RegExp('^/receive/(' + uuid + ')/?$','i').exec(pathname)
  const fragment = /^#token=([A-Za-z0-9_-]{43})$/.exec(hash)
  if (!path || !fragment) return null
  const token = fragment[1]
  const bytes = Uint8Array.from(atob(token.replaceAll('-', '+').replaceAll('_', '/') + '='), char => char.charCodeAt(0))
  return encode(bytes) === token ? { id: path[1], token } : null
}

export function confirmWorkLoss(): boolean {
  return !document.querySelector('[data-work-loss="true"]') || window.confirm('이동하면 선택한 파일·편집 내용·공유 코드와 링크가 지워져요. 필요한 코드와 링크를 별도로 전달했나요?')
}

export async function readSharedBundle(response: Response, size: number, digest: string, code: string, signal: AbortSignal) {
  if (!Number.isSafeInteger(size) || size < 40 || size > LIMITS.bundleBytes || !response.body) {
    await response.body?.cancel()
    throw new Error('공유 파일의 크기를 확인할 수 없어요.')
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > size) throw new Error('공유 파일의 크기가 달라요.')
      chunks.push(value)
    }
  } finally { await reader.cancel(); reader.releaseLock() }
  if (length !== size) throw new Error('공유 파일이 잘렸어요. 다시 열어주세요.')
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  if (await deviceHash(bytes) !== digest) throw new Error('공유 파일이 변경됐어요. 발신자에게 새 공유를 요청해주세요.')
  signal.throwIfAborted()
  const bundle = await openBundle(bytes.buffer, code)
  signal.throwIfAborted()
  return bundle
}

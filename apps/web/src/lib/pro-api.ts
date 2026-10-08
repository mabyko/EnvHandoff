import { limitMessage, ProRequestError } from './pro-feedback.ts'

export async function proRequest(url: string, { csrf, signal, body, errors, onExpired }: {
  csrf: string; signal: AbortSignal; body?: Record<string, unknown> | ArrayBuffer;
  errors: Record<string, string>; onExpired: () => void;
}): Promise<Response> {
  const binary = body instanceof ArrayBuffer
  const response = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'include', cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    headers: body ? { 'content-type': binary ? 'application/octet-stream' : 'application/json', 'x-csrf-token': csrf } : {},
    body: binary ? body : body ? JSON.stringify(body) : undefined })
  if (response.status === 401) { onExpired(); throw new ProRequestError('로그인이 만료됐어요.', 401, 'session_expired') }
  if (!response.ok) {
    const value = await response.json().catch(() => ({}))
    throw new ProRequestError(response.status === 429 ? limitMessage(value.error, response.headers.get('retry-after'))
      : errors[value.error] ?? '처리 결과를 확인하지 못했어요. 상태 확인 후 같은 작업을 다시 시도해주세요.', response.status, value.error)
  }
  signal.throwIfAborted()
  return response
}

// Only an authoritative terminal result releases encrypted retry state. In
// particular, HTTP 404 or a successful response with no status is not enough.
export function uploadResolution(status: string): 'complete' | 'ended' | 'pending' {
  if (status === 'available') return 'complete'
  if (['revoked', 'expired', 'cancelled', 'failed'].includes(status)) return 'ended'
  return 'pending'
}

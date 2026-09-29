export class HttpError extends Error {
  readonly status: number
  constructor(status: number, code = 'request_failed') { super(code); this.status = status }
}

// Match the path that Request/URL will route, before body handling or rate limits.
export function canonicalPath(target: string): string | null {
  if (!target.startsWith('/') || target.startsWith('//') || target.length > 4096 || target.includes('#') || target.includes('\\')) return null
  const path = new URL(target, 'http://localhost').pathname
  return path === target.split('?')[0] ? path : null
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'json_required')
  const reader = request.body?.getReader()
  if (!reader) throw new HttpError(400, 'invalid_input')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8192) { await reader.cancel(); throw new HttpError(413, 'body_too_large') }
      chunks.push(value)
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid_input') }
  finally { reader.releaseLock() }
}

export function fields(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new HttpError(400, 'invalid_input')
}

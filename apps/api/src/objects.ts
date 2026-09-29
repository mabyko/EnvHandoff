import type { FileHandle } from 'node:fs/promises'
import { mkdir, open, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { HttpError } from './http.ts'

// Private, unbacked volume. Object names are generated upload IDs, never user paths.
export class Objects {
  private readonly root: string
  constructor(root: string) { this.root = resolve(root) }
  private path(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid object ID')
    return join(this.root, id)
  }
  async write(id: string, body: ReadableStream<Uint8Array> | null, size: number, digest: string) {
    if (!body) throw new HttpError(400, 'invalid_upload')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const file = await open(this.path(id), 'wx', 0o600), reader = body.getReader(), hash = createHash('sha256')
    const timeout = setTimeout(() => { void reader.cancel().catch(() => {}) }, 120_000)
    let count = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        count += value.byteLength
        if (count > size) throw new HttpError(413, 'invalid_upload')
        hash.update(value)
        // FileHandle.write can make a partial write; retain the unwritten suffix.
        let offset = 0
        while (offset < value.byteLength) offset += (await file.write(value, offset, value.byteLength - offset)).bytesWritten
      }
      if (count !== size || hash.digest('base64url') !== digest) throw new HttpError(400, 'invalid_upload')
      await file.sync(); await file.chmod(0o400)
      const directory = await open(this.root, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } finally { clearTimeout(timeout); await reader.cancel().catch(() => {}); reader.releaseLock(); await file.close() }
  }
  async remove(id: string) {
    try { await unlink(this.path(id)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  async read(id: string, size: number, settle: (bytes: number) => Promise<void>) {
    const path = this.path(id)
    let file: FileHandle | undefined
    let timeout: ReturnType<typeof setTimeout>
    let bytes = 0, closed = false
    const close = async () => { if (closed) return; closed = true; clearTimeout(timeout); try { await file?.close() } finally { await settle(bytes) } }
    return new ReadableStream<Uint8Array>({
      start(controller) {
        // End active streams before their five-minute download reservation expires.
        timeout = setTimeout(() => { void close().then(() => controller.error(new HttpError(408, 'download_timeout')), error => controller.error(error)) }, 120_000)
        timeout.unref()
      },
      async pull(controller) {
        try {
          file ??= await open(path, 'r')
          if (closed) { await file.close(); return }
          const buffer = new Uint8Array(Math.min(64 * 1024, size - bytes))
          const { bytesRead } = await file.read(buffer)
          if (closed) return
          if (!bytesRead && bytes < size) throw new Error('Truncated object')
          bytes += bytesRead
          if (bytesRead) controller.enqueue(buffer.subarray(0, bytesRead))
          if (bytes === size) { await close(); controller.close() }
        } catch (error) { await close(); controller.error(error) }
      },
      cancel: close,
    }, { highWaterMark: 0 })
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function downloadFile(bytes: ArrayBuffer, filename: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // Give browsers time to start the download before releasing the blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function previewText(bytes: Uint8Array): { text: string; truncated: boolean } | null {
  try {
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    // Keep tab/newline characters, but do not render binary control characters.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(content)) return null
    return { text: content.slice(0, 16_384), truncated: content.length > 16_384 }
  } catch {
    return null
  }
}

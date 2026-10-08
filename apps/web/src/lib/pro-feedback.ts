export const betaClosedMessage = '서버에서 신규 파일 전달을 일시 중지했어요. 새 요청과 업로드는 운영자가 재개한 뒤 가능해요. 기존 전달은 원래 기한까지 받을 수 있어요.'

export class ProRequestError extends Error {
  readonly status: number
  readonly code?: string
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code }
}

// A rejected first reservation has no upload to recover. Network/5xx outcomes
// may have committed, so retain their operation ID and encrypted bytes.
export function reservationRejected(error: unknown): boolean {
  return error instanceof ProRequestError && (error.code === 'beta_closed' || (error.status >= 400 && error.status < 500 && error.status !== 408))
}

export function subscribeTabReturn(refresh: () => void): () => void {
  const visible = () => { if (document.visibilityState === 'visible') refresh() }
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', visible)
  return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visible) }
}

export function limitMessage(code: string, retryAfter: string | null, now = Date.now()): string {
  if (retryAfter) {
    const seconds = /^\d+$/.test(retryAfter) ? Number(retryAfter) : (Date.parse(retryAfter) - now) / 1000
    if (Number.isFinite(seconds) && seconds > 0 && seconds <= 7 * 86400) return `사용 한도에 도달했어요. ${Math.ceil(seconds / 60)}분 뒤 다시 시도해주세요.`
  }
  if (code === 'beta_code_limit') return '사용 가능한 베타 코드는 최대 100개예요. 사용하지 않는 코드를 취소한 뒤 다시 발급해주세요.'
  if (code === 'storage_limit') return '조직 보관량 512 MiB 또는 동시 업로드 3개 한도에 도달했어요. 진행 중인 업로드가 끝난 뒤 다시 시도해주세요. 보관량 초과라면 회수·만료된 파일의 저장소 삭제가 끝나야 공간을 다시 쓸 수 있어요.'
  if (code === 'download_limit') return '동시 다운로드 3개 또는 하루 1 GiB 한도에 도달했어요. 진행 중인 다운로드가 끝난 뒤 다시 시도해주세요. 일일 한도는 다음 UTC 00:00(한국 시간 오전 9시)에 초기화돼요.'
  if (code === 'request_limit') return '진행 중인 요청 100개 한도에 도달했어요. 기존 요청을 완료하거나 취소한 뒤 다시 시도해주세요.'
  if (code === 'request_rate_limit') return '10분 동안 요청·공유·업로드 시도를 합쳐 20개까지 만들 수 있어요. 10분 뒤 다시 시도해주세요.'
  if (code === 'challenge_limit') return '진행 중인 기기 확인이 많아요. 기존 확인이 만료되는 5분 뒤 다시 시도해주세요.'
  if (code === 'share_rate_limit') return '공유 조회·다운로드 요청이 많아요. 1분 뒤 다시 시도해주세요.'
  return '요청이 너무 많아요. 10분 뒤 다시 시도해주세요.'
}

export function uploadEncrypted(url: string, bytes: ArrayBuffer, headers: Record<string, string>, signal: AbortSignal, progress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const xhr = new XMLHttpRequest(), abort = () => xhr.abort()
    xhr.open('POST', url); xhr.withCredentials = true; xhr.timeout = 120_000
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)
    xhr.upload.onprogress = event => { if (!signal.aborted && event.lengthComputable) progress(Math.min(99, Math.round(event.loaded / event.total * 100))) }
    xhr.onload = () => {
      if (xhr.status === 200) { resolve(); return }
      let code = ''
      try { code = JSON.parse(xhr.responseText).error ?? '' } catch { /* No response body is required for infrastructure errors. */ }
      const error = new Error(xhr.status === 429 ? limitMessage(code, xhr.getResponseHeader('retry-after')) : xhr.status === 401 ? '로그인이 만료됐어요.' : code === 'beta_closed' ? betaClosedMessage : '업로드 결과를 확인하지 못했어요. 업로드 상태를 확인해주세요.')
      error.name = xhr.status === 401 ? 'SessionExpired' : 'Error'
      reject(error)
    }
    xhr.onerror = xhr.ontimeout = () => reject(new Error('업로드 연결이 끊겼어요. 업로드 상태를 확인한 뒤 같은 시도를 다시 보내주세요.'))
    xhr.onabort = () => reject(new DOMException('업로드를 중단했어요.', 'AbortError'))
    xhr.onloadend = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true }); xhr.send(bytes)
  })
}

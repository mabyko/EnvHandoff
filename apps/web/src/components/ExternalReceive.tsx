import { useEffect, useRef, useState } from 'react'
import { CodeInput, Heading, Notice } from './ui.tsx'
import { OpenedFiles } from './ReceiveFlow.tsx'
import { explainError } from '../lib/bundle.ts'
import type { OpenedBundle } from '../lib/bundle.ts'
import { limitMessage } from '../lib/pro-feedback.ts'
import { readSharedBundle } from '../lib/external-share.ts'

const api = import.meta.env.VITE_PRO_API_ORIGIN ?? (import.meta.env.DEV ? 'http://localhost:3001' : 'https://api.envhandoff.mabyko.com')
type Preview = { id: string; status: string; size: number; digest: string; expiresAt: number; acknowledgedAt: number | null }
const unavailable = '이 공유를 열 수 없어요. 링크가 잘못됐거나 만료·회수됐을 수 있어요. 발신자에게 새 링크를 요청해주세요.'

export function ExternalReceive({ id, token, onHome }: { id?: string; token?: string; onHome: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null), [code, setCode] = useState('')
  const [opened, setOpened] = useState<OpenedBundle | null>(null), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  const lifetime = useRef<AbortController | null>(null), running = useRef(false)
  const sensitive = !!token || !!code || !!opened
  async function call(path: string, signal: AbortSignal, post = false) {
    const response = await fetch(`${api}/shares/${id}${path}`, { method: post ? 'POST' : 'GET', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]), headers: { 'x-share-token': token!, ...(post ? { 'content-type': 'application/json' } : {}) }, body: post ? '{}' : undefined })
    if (!response.ok) {
      if (response.status === 429) { const value = await response.json().catch(() => ({})); throw new Error(limitMessage(value.error ?? 'share_rate_limit', response.headers.get('retry-after'))) }
      throw new Error(unavailable)
    }
    return response
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller
    if (id && token) void call('', controller.signal).then(response => response.json()).then((value: Preview) => { if (!controller.signal.aborted) setPreview(value) }).catch(e => { if (!controller.signal.aborted) setError(e instanceof TypeError ? '서버에 연결하지 못했어요. 원래 링크를 다시 열어주세요.' : e.message) })
    return () => controller.abort()
    // The route is keyed by link arrival; credentials stay only in its mounted state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, token])
  useEffect(() => {
    if (!sensitive) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [sensitive])
  async function receive() {
    if (running.current || !id || !token) return
    running.current = true; setBusy(true); setError(''); setMessage(''); setOpened(null)
    const signal = lifetime.current!.signal
    try {
      const info: Preview = await (await call('', signal)).json()
      if (info.id !== id || info.status !== 'available') throw new Error(unavailable)
      const response = await call('/content', signal, true)
      const bundle = await readSharedBundle(response, info.size, info.digest, code.trim(), signal)
      if (signal.aborted) return
      setOpened(bundle); setCode(''); setPreview(info)
      try {
        const acknowledged: Preview = await (await call('/ack', signal, true)).json()
        if (!signal.aborted) { setPreview(acknowledged); setMessage('파일 검사를 통과했고 수신 확인을 남겼어요.') }
      } catch { if (!signal.aborted) setMessage('파일은 열었지만 수신 확인을 저장하지 못했어요. 파일을 다시 열면 재시도해요.') }
    } catch (e) { if (!signal.aborted) setError(e instanceof Error && e.name === 'Error' ? e.message : explainError(e)) }
    finally { running.current = false; if (!signal.aborted) setBusy(false) }
  }
  return <section aria-busy={busy} data-work-loss={sensitive}>
    <Heading title="공유 파일 받기">로그인 없이, 별도로 받은 공유 코드로 파일을 열어요.</Heading>
    {!token || !id ? <Notice error>접근 토큰이 없거나 링크가 올바르지 않아요. 새로고침했다면 발신자에게 받은 원래 링크를 다시 열어주세요.</Notice> : <>
      {preview && <p>{new Date(preview.expiresAt).toLocaleString('ko-KR')}까지 열 수 있어요. {preview.acknowledgedAt ? '이 공유의 수신 확인이 기록돼 있어요.' : '아직 수신 확인 전이에요.'}</p>}
      <p>공유 코드는 링크를 받은 곳과 다른 대화 경로로 받아주세요. 페이지 방문만으로 파일을 받거나 수신 확인을 남기지 않아요.</p>
      <form onSubmit={event => { event.preventDefault(); void receive() }}>
        <fieldset className="plain-fieldset" disabled={busy}>
          <legend>공유 코드로 열기</legend><CodeInput value={code} onChange={setCode} />
          <button type="submit" className="button primary" disabled={!code.trim()}>{busy ? '다운로드·검사 중…' : '파일 열기'}</button>
        </fieldset>
      </form>
      <details className="share-options"><summary>수신 확인과 코드 분실 안내</summary>
        <p>수신 확인은 파일 검사를 마쳤다는 보고예요. 받는 사람의 신원이나 파일 저장·프로젝트 적용을 증명하지 않아요.</p>
        <p>코드를 잃었다면 복구할 수 없어요. 발신자가 원본으로 새 공유를 만들어야 해요.</p>
      </details>
    </>}
    {error && <Notice error>{error}</Notice>}{message && <p role="status">{message}</p>}
    {opened && <><OpenedFiles bundle={opened} /><button className="button" type="button" onClick={() => setOpened(null)}>열어둔 파일 닫기</button></>}
    <div className="actions"><button className="button" type="button" onClick={onHome}>소개로 돌아가기</button></div>
  </section>
}

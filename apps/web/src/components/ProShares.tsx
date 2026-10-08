import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { betaClosedMessage, reservationRejected, subscribeTabReturn, uploadEncrypted } from '../lib/pro-feedback.ts'
import { proRequest, uploadResolution } from '../lib/pro-api.ts'
import { CopyField, Notice } from './ui.tsx'
import { createBundle, explainError, validateFiles } from '../lib/bundle.ts'
import type { SourceFile } from '../lib/bundle.ts'
import { followProLink, proPath } from '../lib/pro-navigation.ts'
import type { ProRoute } from '../lib/pro-navigation.ts'
import { createShareToken, hashShareToken } from '../lib/external-share.ts'
import { deviceHash } from '@envhandoff/protocol/device-proof'
import { parseEditableEnv, previewEnvEdit } from '../lib/env.ts'

type Share = { id: string; status: string; createdAt: number; expiresAt: number | null; acknowledgedAt: number | null; project?: string; environment?: string; environmentId?: string; canReissue: boolean; canRevoke: boolean }
type Environment = { id: string; project: string; name: string }
type Secret = { token: string; code?: string }
type Pending = Secret & { id: string; bytes: ArrayBuffer; digest: string; tokenHash: string; environmentId: string; days: number }
const statuses: Record<string, string> = { reserved: '업로드 대기', writing: '서버 저장 중', uploading: '업로드 중', available: '공유 중', revoked: '회수됨', expired: '만료됨', cancelled: '취소됨', failed: '업로드 실패' }
const errors: Record<string, string> = { beta_closed: betaClosedMessage, share_unavailable: '공유를 확인할 수 없어요. 목록을 다시 확인해주세요.', file_permission_required: '외부 공유 권한이 없어요. Owner에게 권한을 요청해주세요.', creator_required: '공유를 만든 사람만 링크를 재발급할 수 있어요.', storage_limit: '워크스페이스 저장 용량 또는 동시 업로드 한도에 도달했어요.', request_rate_limit: '생성 한도에 도달했어요. 10분 뒤 다시 시도해주세요.', operation_conflict: '이 작업의 내용이 달라요. 업로드 상태를 확인해주세요.', upload_in_progress: '업로드 처리 중이에요. 상태를 확인한 뒤 다시 시도해주세요.', storage_unavailable: '파일 저장소가 아직 준비되지 않았어요.' }

export function ProShares({ api, orgId, userId, csrf, targetId, route, onNavigate, disabled, acceptNewTransfers = true, onExpired }: { api: string; orgId: string; userId: string; csrf: string; targetId?: string; route: ProRoute; onNavigate: (route: ProRoute) => void; disabled: boolean; acceptNewTransfers?: boolean; onExpired: () => void }) {
  const detailId = route.id ?? targetId
  const routeKey = JSON.stringify([detailId, route.create, route.environmentId])
  const currentView = useRef({ id: detailId, create: route.create, environmentId: route.environmentId, key: routeKey })
  useLayoutEffect(() => { currentView.current = { id: detailId, create: route.create, environmentId: route.environmentId, key: routeKey } })
  const loadedView = useRef(''), appliedEnvironment = useRef(route.environmentId)
  const [shares, setShares] = useState<Share[]>([]), [environments, setEnvironments] = useState<Environment[]>([])
  const [environmentId, setEnvironmentId] = useState(route.environmentId ?? ''), [files, setFiles] = useState<SourceFile[]>([]), [days, setDays] = useState(1)
  const [pending, setPending] = useState<Pending | null>(null), [secrets, setSecrets] = useState<Record<string, Secret>>({})
  const [editing, setEditing] = useState<{ index: number; source: ReturnType<typeof parseEditableEnv>; values: string[] } | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const work = useRef<AbortController | null>(null)
  const [progress, setProgress] = useState(0), [uploading, setUploading] = useState(false)
  const lifetime = useRef<AbortController | null>(null), running = useRef<AbortController | null>(null), expired = useRef(onExpired)
  const [reissues, setReissues] = useState(new Map<string, { operationId: string; token: string; tokenHash: string }>())
  const revocations = useRef(new Map<string, string>())
  useLayoutEffect(() => { expired.current = onExpired })
  const base = `/organizations/${orgId}/shares`
  const sensitive = files.length > 0 || !!pending || Object.keys(secrets).length > 0 || reissues.size > 0
  const listRoute: ProRoute = { page: 'shares', orgId }, createRoute: ProRoute = { ...listRoute, create: true }

  async function call(path: string, signal: AbortSignal, body?: Record<string, unknown> | ArrayBuffer) {
    return (await proRequest(api + path, { csrf, signal, body, errors, onExpired: () => expired.current() })).json()
  }

  async function load(signal: AbortSignal) {
    const view = currentView.current
    try {
      if (view.create) {
        const catalog = await call(`/organizations/${orgId}/catalog`, signal)
        if (signal.aborted || view.key !== currentView.current.key) return
        const available: Environment[] = catalog.projects.flatMap((project: { name: string; environments: { id: string; name: string; permissions: { externalShare: boolean } }[] }) => project.environments.filter(env => env.permissions.externalShare).map(env => ({ id: env.id, name: env.name, project: project.name })))
        setEnvironments(available)
        const environmentChanged = appliedEnvironment.current !== view.environmentId
        appliedEnvironment.current = view.environmentId
        setEnvironmentId(current => {
          if (pending) return pending.environmentId
          const requested = environmentChanged ? view.environmentId ?? '' : current
          return requested || available[0]?.id || ''
        })
        if (view.environmentId && !available.some(env => env.id === view.environmentId)) setError('선택한 환경에 외부 공유 권한이 없어요. 다른 환경을 선택하거나 Owner에게 권한을 요청해주세요.')
      } else {
        const result = await call(base + (view.id ? '/' + view.id : ''), signal)
        if (signal.aborted || view.key !== currentView.current.key) return
        if (view.id && result.id !== view.id) throw new Error('링크의 공유를 확인할 수 없어요.')
        const items: Share[] = view.id ? [result] : result.shares
        setShares(items)
        const ended = new Set(items.filter(share => !['reserved', 'writing', 'uploading', 'available'].includes(share.status)).map(share => share.id))
        setSecrets(current => Object.fromEntries(Object.entries(current).filter(([id]) => !ended.has(id))))
        setReissues(current => new Map([...current].filter(([id]) => !ended.has(id))))
      }
    } catch (e) {
      if (!signal.aborted && view.key === currentView.current.key) { if (view.create) setEnvironments([]); else setShares([]) }
      throw e
    }
  }
  async function run(action: (signal: AbortSignal) => Promise<void>, isUpload = false) {
    const controller = lifetime.current!
    if (running.current === controller || controller.signal.aborted) return
    const task = new AbortController(); work.current = task
    const signal = AbortSignal.any([controller.signal, task.signal])
    running.current = controller; setBusy(true); setUploading(isUpload); if (isUpload) setProgress(0); setError(''); setMessage('')
    try { await action(signal) }
    catch (e) { if (!signal.aborted) setError(e instanceof Error && e.name === 'Error' ? e.message : explainError(e)) }
    finally { if (work.current === task) work.current = null; if (running.current === controller) running.current = null; if (!controller.signal.aborted) { setBusy(false); setUploading(false) } }
  }
  const refresh = useRef(() => {})
  useLayoutEffect(() => { refresh.current = () => { if (running.current === lifetime.current) return; loadedView.current = currentView.current.key; void run(load) } })
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller
    const revokeOperations = revocations.current
    const reload = () => refresh.current()
    reload(); const stop = subscribeTabReturn(reload)
    return () => { controller.abort(); revokeOperations.clear(); stop() }
  }, [api, orgId, userId, csrf])
  useEffect(() => { if (!busy && loadedView.current !== routeKey) refresh.current() }, [routeKey, busy])
  useEffect(() => {
    if (!sensitive) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [sensitive])
  async function finish(upload: Pending, signal: AbortSignal) {
    setSecrets(current => ({ ...current, [upload.id]: { token: upload.token, code: upload.code } }))
    setPending(null); setFiles([]); setEditing(null)
    signal.throwIfAborted()
    setMessage('공유를 만들었어요. 링크와 코드를 서로 다른 대화 경로로 전달해주세요.')
    onNavigate({ page: 'shares', orgId, id: upload.id })
  }
  async function send(signal: AbortSignal) {
    if (!acceptNewTransfers) throw new Error(betaClosedMessage)
    const firstAttempt = !pending
    let upload = pending
    if (!upload) {
      const env = environments.find(env => env.id === environmentId)
      if (!env) throw new Error('외부 공유 권한이 있는 환경을 선택해주세요.')
      const bundle = await createBundle(files, env.project, env.name), token = createShareToken()
      upload = { id: crypto.randomUUID(), bytes: bundle.bytes, code: bundle.code, token, tokenHash: await hashShareToken(token), digest: await deviceHash(new Uint8Array(bundle.bytes)), environmentId: env.id, days }
      signal.throwIfAborted(); setPending(upload)
    }
    let reserved: Share
    try { reserved = await call(base, signal, { operationId: upload.id, environmentId: upload.environmentId, size: upload.bytes.byteLength, digest: upload.digest, retentionDays: upload.days, tokenHash: upload.tokenHash }) }
    catch (error) { if (firstAttempt && reservationRejected(error) && !signal.aborted) setPending(null); throw error }
    if (reserved.status === 'available') { await finish(upload, signal); return }
    if (reserved.status !== 'reserved') throw new Error('이 업로드를 계속할 수 없어요. 상태를 확인한 뒤 종료된 시도는 지우고 다시 준비해주세요.')
    setProgress(0)
    try { await uploadEncrypted(api + base + '/' + upload.id + '/content', upload.bytes, { 'x-csrf-token': csrf }, signal, setProgress) }
    catch (e) { if (e instanceof Error && e.name === 'SessionExpired') expired.current(); throw e }
    if (!signal.aborted) setProgress(100)
    signal.throwIfAborted(); await finish(upload, signal)
  }
  async function reissue(share: Share, signal: AbortSignal) {
    let operation = reissues.get(share.id)
    if (!operation) { const token = createShareToken(); operation = { token, tokenHash: await hashShareToken(token), operationId: crypto.randomUUID() }; signal.throwIfAborted(); setReissues(current => new Map(current).set(share.id, operation!)) }
    await call(base + '/' + share.id + '/reissue', signal, { operationId: operation.operationId, tokenHash: operation.tokenHash })
    setSecrets(current => ({ ...current, [share.id]: { ...current[share.id], token: operation.token } })); setReissues(current => { const next = new Map(current); next.delete(share.id); return next })
    await load(signal); setMessage('새 링크를 발급했어요. 기존 링크는 사용할 수 없고 코드와 보관 기한은 그대로예요.')
  }
  async function revoke(id: string, signal: AbortSignal) {
    const operationId = revocations.current.get(id) ?? crypto.randomUUID(); revocations.current.set(id, operationId)
    await call(base + '/' + id + '/revoke', signal, { operationId })
    revocations.current.delete(id); setReissues(current => { const next = new Map(current); next.delete(id); return next })
    setSecrets(current => { const next = { ...current }; delete next[id]; return next })
    if (pending?.id === id) setPending(null)
    await load(signal); setMessage('공유를 회수했어요. 이미 받은 로컬 사본은 지워지지 않아요.')
  }
  async function resolvePending(state: Share, upload: Pending, signal: AbortSignal) {
    const resolution = uploadResolution(state.status)
    if (resolution === 'complete') await finish(upload, signal)
    else if (resolution === 'ended') {
      setPending(null); setProgress(0); await load(signal)
      setMessage('이전 업로드가 종료됐어요. 원본으로 새 공유를 만들 수 있어요.')
    } else setMessage('업로드 상태: ' + (statuses[state.status] ?? '확인 중'))
  }
  async function cancelPending(upload: Pending, signal: AbortSignal) {
    const operationId = revocations.current.get(upload.id) ?? crypto.randomUUID()
    revocations.current.set(upload.id, operationId)
    const result: Share = await call(base + '/' + upload.id + '/cancel', signal, { operationId })
    if (uploadResolution(result.status) === 'pending') throw new Error('취소 결과를 확인하지 못했어요. 같은 시도를 다시 취소해주세요.')
    revocations.current.delete(upload.id)
    await resolvePending(result, upload, signal)
  }
  const draft = editing
  const shown = detailId ? shares.filter(share => share.id === detailId) : shares
  const uploadRecovery = pending && <div className="actions"><button type="button" className="button" disabled={busy || disabled} onClick={() => { void run(async signal => { await resolvePending(await call(base + '/' + pending.id, signal), pending, signal) }) }}>업로드 상태 확인</button><button type="button" className="button" disabled={busy || disabled} onClick={() => { if (window.confirm('이 업로드 시도를 취소할까요? 이미 완료됐다면 공유 링크와 코드를 확인해요.')) void run(signal => cancelPending(pending, signal)) }}>업로드 시도 취소</button></div>
  return <section className="pro-shares" aria-label="외부 공유" aria-busy={busy || disabled} data-work-loss={sensitive}>
    <header className="pro-page-header"><div><h2>{route.create ? '외부 공유 만들기' : detailId ? '외부 공유 상세' : '외부 공유'}</h2><p>{route.create ? '파일을 암호화하고 팀 외부의 사람에게 전달하세요.' : detailId ? '접근 링크와 코드를 전달하고 수신 상태를 확인하세요.' : '비회원에게 공유한 파일의 기한과 수신 상태를 확인하세요.'}</p></div>
      <div className="actions">{(detailId || route.create) ? <a className="button" href={proPath(listRoute)} onClick={event => followProLink(event, listRoute, onNavigate)}>공유 목록</a> : <a className="button primary" href={proPath(createRoute)} onClick={event => followProLink(event, createRoute, onNavigate)}>새 외부 공유</a>}
        <button className="button" type="button" disabled={busy || disabled} onClick={() => refresh.current()}>새로고침</button></div>
    </header>
    {error && <Notice error>{error}</Notice>}<p className="pro-status-line" role="status">{busy ? uploading && pending ? `암호문을 업로드하고 있어요. ${progress}%` : '공유 정보를 확인하거나 처리하고 있어요.' : message}</p>
    {route.create ? <>
      {!acceptNewTransfers && <Notice>{betaClosedMessage}</Notice>}
      <p>기기 등록 없이 비회원에게 보낼 수 있어요. 환경별 외부 공유 권한이 필요해요.</p>
      <fieldset className="plain-fieldset pro-form-panel" disabled={busy || disabled}>
        <legend>새 공유 만들기</legend>
        {!environments.length && !busy && <Notice>공유 가능한 환경이 없어요. Owner에게 외부 공유 권한을 요청해주세요.</Notice>}
        {!!environments.length && <>
          <label className="pro-form">공유할 환경<select value={environmentId} disabled={!!pending} onChange={e => setEnvironmentId(e.target.value)}>{!environmentId && <option value="" disabled>환경을 선택해주세요</option>}{environmentId && !environments.some(env => env.id === environmentId) && <option value={environmentId} disabled>선택한 환경을 사용할 수 없어요. 다시 선택해주세요.</option>}{environments.map(env => <option key={env.id} value={env.id}>{env.project} / {env.name}</option>)}</select></label>
          <label className="pro-form">보낼 파일<input type="file" multiple disabled={!!pending} onChange={event => { const selected = Array.from(event.target.files ?? []).map(file => ({ file, path: file.name })); try { validateFiles(selected.map(item => ({ path: item.path, size: item.file.size }))); setFiles(selected); setEditing(null); setError('') } catch (e) { setError(explainError(e)) } event.target.value = '' }} /></label>
          {files.map((file, index) => <div key={index} className="pro-form"><label>배치 경로<input value={file.path} disabled={!!pending} onChange={e => setFiles(current => current.map((item, i) => i === index ? { ...item, path: e.target.value } : item))} /></label>
            {file.path.split('/').at(-1)?.startsWith('.env') && <button className="button" type="button" disabled={!!pending} onClick={() => { void run(async signal => { const source = parseEditableEnv(new Uint8Array(await file.file.arrayBuffer())); signal.throwIfAborted(); setEditing({ index, source, values: source.entries.map(entry => entry.value) }) }) }}>환경변수 편집</button>}
          </div>)}
          {draft && <form className="pro-form" onSubmit={event => { event.preventDefault(); try { const preview = previewEnvEdit(draft.source, draft.values); if (!window.confirm('수정한 값을 보낼 파일에 적용할까요?')) return; setFiles(current => current.map((file, i) => i === draft.index ? { ...file, file: new File([preview.text], file.file.name) } : file)); setEditing(null) } catch (e) { setError(explainError(e)) } }}>
            {draft.source.entries.map((entry, index) => <label key={index}>{entry.key}<input value={draft.values[index]} autoComplete="off" spellCheck={false} onChange={e => setEditing({ ...draft, values: draft.values.map((value, i) => i === index ? e.target.value : value) })} /></label>)}
            <button type="submit" className="button">수정본 적용</button><button type="button" className="button" onClick={() => setEditing(null)}>편집 취소</button>
          </form>}
          <label className="pro-form">보관 기간<select value={days} disabled={!!pending} onChange={e => setDays(Number(e.target.value))}><option value={1}>24시간</option><option value={3}>3일</option><option value={7}>7일</option></select></label>
          <p>조직·프로젝트·환경 이름은 서버에 저장돼요. 파일 이름·배치 경로·내용은 암호화된 묶음 안에만 담겨요.</p>
          <p>업로드 확정부터 이용할 수 있어요. 만료·회수 뒤 저장소 삭제까지 최대 24시간이 더 걸릴 수 있어요.</p>
          <button type="button" className="button primary" disabled={!acceptNewTransfers || !files.length || !!draft || !environments.some(env => env.id === environmentId)} onClick={() => { void run(send, true) }}>{pending ? '같은 업로드 재시도' : '암호화해서 외부 공유'}</button>
        </>}
        {uploadRecovery}
        <p>공유 코드는 이 탭에서만 다시 볼 수 있어요. 만든 뒤 링크와 코드를 서로 다른 대화 경로로 전달해주세요.</p>
      </fieldset>
    </> : <>
      {!detailId && <p>링크와 공유 코드로 비회원에게 전달한 파일이에요. 공유를 열어 수신 상태를 확인하거나 회수할 수 있어요.</p>}
      {(pending || files.length > 0) && <Notice>이 탭에 작성 중인 공유가 있어요. <a href={proPath(createRoute)} onClick={event => followProLink(event, createRoute, onNavigate)}>작성 화면으로 돌아가기</a></Notice>}
      {!busy && !shown.length && !error && <div className="pro-empty-state"><h3>{detailId ? '공유를 찾을 수 없어요' : '아직 외부에 공유한 파일이 없어요'}</h3><p>{detailId ? '원래 링크와 현재 계정을 확인해주세요.' : '새 외부 공유를 눌러 파일과 보관 기간을 선택하세요.'}</p></div>}
      <div className={detailId ? 'pro-detail' : 'pro-list'}>{shown.map(share => {
        const destination: ProRoute = { page: 'shares', orgId, id: share.id }
        return <article key={share.id} className="pro-project" aria-label={share.project ? `${share.project} ${share.environment} 공유` : '종료된 공유'}>
          <h3>{detailId ? (share.project ? `${share.project} / ${share.environment}` : '종료된 공유') : <a href={proPath(destination)} onClick={event => followProLink(event, destination, onNavigate)}>{share.project ? `${share.project} / ${share.environment}` : '종료된 공유'}</a>}</h3>
          <p className="pro-item-meta"><strong className="pro-badge" data-status={share.status}>{statuses[share.status] ?? share.status}</strong> {new Date(share.createdAt).toLocaleString('ko-KR')}{share.expiresAt ? ` · ${new Date(share.expiresAt).toLocaleString('ko-KR')}까지` : ''}</p>
          <p>{share.acknowledgedAt ? `수신 확인: ${new Date(share.acknowledgedAt).toLocaleString('ko-KR')}` : '수신 확인 전'}</p>
          {detailId ? <>
            <p>수신 확인은 파일 검사를 마쳤다는 보고예요. 받는 사람의 신원이나 파일 저장·프로젝트 적용을 증명하지 않아요.</p>
            <details><summary>팀 내부 관리 링크</summary><CopyField label="공유 상세 링크 (로그인 필요)" value={location.origin + proPath(destination)} /><p className="device-id">{share.id}</p></details>
            <fieldset className="plain-fieldset" disabled={busy || disabled}><legend>공유 관리</legend>
              {share.status === 'available' && secrets[share.id] && <>{reissues.has(share.id) ? <Notice>링크 재발급 결과를 확인하지 못했어요. 같은 작업을 재시도해주세요.</Notice> : <CopyField label="상대에게 전달할 접근 링크" value={`${location.origin}/receive/${share.id}#token=${secrets[share.id].token}`} />}{secrets[share.id].code ? <CopyField label="다른 경로로 전달할 공유 코드" value={secrets[share.id].code!} secret /> : <Notice>이 탭에는 코드가 없어요. 링크 재발급으로 코드는 복원되지 않아요.</Notice>}</>}
              {share.status === 'available' && !secrets[share.id] && <Notice>링크·코드는 서버에서 다시 읽을 수 없어요. 생성자는 링크를 재발급할 수 있지만 코드는 복구되지 않아요.</Notice>}
              {share.status === 'available' && <p>다른 화면으로 이동하거나 새로고침·로그아웃하기 전에 링크와 코드를 전달해주세요. 코드를 잃으면 원본으로 새 공유를 만들고 기존 공유를 회수해주세요.</p>}
              <div className="actions">{share.canReissue && <button className="button" type="button" onClick={() => { if (reissues.has(share.id) || window.confirm('기존 링크가 즉시 무효화돼요. 코드는 그대로 유지하고 링크를 재발급할까요?')) void run(signal => reissue(share, signal)) }}>{reissues.has(share.id) ? '같은 링크 재발급 재시도' : '링크 재발급'}</button>}
                {share.canRevoke && <button className="button pro-danger" type="button" onClick={() => { if (window.confirm('공유를 회수할까요? 이미 내려받은 사본은 지워지지 않아요.')) void run(signal => revoke(share.id, signal)) }}>공유 회수</button>}
              </div>
              {pending?.id === share.id && uploadRecovery}
              {['reserved', 'writing', 'uploading'].includes(share.status) && !pending && <Notice>이 탭에는 업로드할 파일과 코드가 없어요. 이전 시도를 회수한 뒤 원본으로 새 공유를 만들어주세요.</Notice>}
            </fieldset>
          </> : <a className="button" href={proPath(destination)} onClick={event => followProLink(event, destination, onNavigate)}>공유 열기</a>}
        </article>
      })}</div>
    </>}
    {busy && uploading && pending && <><p>업로드 중에는 페이지를 닫지 말아주세요.</p><progress max={100} value={progress} aria-label="암호문 업로드 진행률" /><button type="button" className="button" onClick={() => { work.current?.abort(); setMessage('전송을 중단했어요. 업로드 상태를 확인한 뒤 완료 여부를 확인하거나 시도를 취소해주세요.') }}>전송 중단</button></>}
  </section>
}

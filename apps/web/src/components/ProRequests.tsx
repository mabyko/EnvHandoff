import { proRequest } from '../lib/pro-api.ts'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ProTransfer } from './ProTransfer.tsx'
import { betaClosedMessage, ProRequestError, subscribeTabReturn } from '../lib/pro-feedback.ts'
import { CopyField, Notice } from './ui.tsx'
import { followProLink, proPath } from '../lib/pro-navigation.ts'
import type { ProRoute } from '../lib/pro-navigation.ts'
import { loadLocalDevice } from '../lib/device-keys.ts'

type Item = { id: string; status: string; direction: string; createdAt: number; expiresAt: number; project?: string; environment?: string; sender?: string; receiver?: string; receiverDeviceId?: string; transfer?: { id: string; status: string; expiresAt: number; acknowledgedAt: number | null } }
type Environment = { id: string; label: string }
type Sender = { id: string; login: string }
const statuses: Record<string, string> = { pending: '승인 대기', approved: '승인됨', rejected: '거절됨', cancelled: '취소됨', expired: '만료됨', fulfilled: '전달 완료' }
const errors: Record<string, string> = {
  beta_closed: betaClosedMessage,
  device_required: '이 브라우저의 기기를 먼저 등록하고 승인받아주세요.',
  file_permission_required: '파일 권한이 바뀌었어요. 새로고침 후 확인해주세요.',
  organization_not_found: '워크스페이스에 접근할 수 없어요.',
  organization_inactive: '워크스페이스 참여가 중지됐어요.',
  request_unavailable: '이 요청을 확인할 수 없어요. 현재 계정과 워크스페이스를 확인해주세요.',
  request_closed: '이미 처리되거나 종료된 요청이에요. 상태를 새로고침해주세요.',
  sender_unavailable: '이 멤버에게 지금 요청할 수 없어요. 요청 가능한 멤버를 새로고침해주세요.',
  sender_required: '지정된 송신자만 승인하거나 거절할 수 있어요.',
  request_limit: '워크스페이스의 진행 중인 요청이 100개에 도달했어요.',
  request_rate_limit: '10분 동안 요청을 20개까지 만들 수 있어요. 잠시 후 다시 시도해주세요.',
  operation_conflict: '처리 중인 요청과 내용이 달라요. 목록을 확인하고 다시 시도해주세요.',
}

export function ProRequests({ api, orgId, userId, csrf, targetId, route, onNavigate, disabled, acceptNewTransfers = true, onExpired }: { api: string; orgId: string; userId: string; csrf: string; targetId?: string; route: ProRoute; onNavigate: (route: ProRoute) => void; disabled: boolean; acceptNewTransfers?: boolean; onExpired: () => void }) {
  const detailId = route.id ?? targetId
  const routeKey = JSON.stringify([detailId, route.create, route.environmentId])
  const currentView = useRef({ id: detailId, create: route.create, environmentId: route.environmentId, key: routeKey })
  useLayoutEffect(() => { currentView.current = { id: detailId, create: route.create, environmentId: route.environmentId, key: routeKey } })
  const loadedView = useRef(''), appliedEnvironment = useRef(route.environmentId), senderEnvironment = useRef('')
  const [items, setItems] = useState<Item[]>([]), [environments, setEnvironments] = useState<Environment[]>([])
  const [environmentId, setEnvironmentId] = useState(route.environmentId ?? ''), [senders, setSenders] = useState<Sender[]>([]), [senderId, setSenderId] = useState('')
  const [busy, setBusy] = useState(true), [choosing, setChoosing] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [accessUnavailable, setAccessUnavailable] = useState(false)
  const lifetime = useRef<AbortController | null>(null), running = useRef<AbortController | null>(null)
  const operations = useRef(new Map<string, string>()), expired = useRef(onExpired)
  useLayoutEffect(() => { expired.current = onExpired })
  const base = '/organizations/' + orgId
  const listRoute: ProRoute = { page: 'requests', orgId }, createRoute: ProRoute = { ...listRoute, create: true }

  async function call(path: string, body?: Record<string, unknown>, signal = lifetime.current!.signal) {
    const response = await proRequest(api + path, { csrf, body, errors, onExpired: () => expired.current(),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
    const value = await response.json().catch(() => ({}))
    signal.throwIfAborted()
    return value
  }
  async function load() {
    const signal = lifetime.current!.signal, view = currentView.current
    try {
      if (view.create) {
        const catalog = await call(base + '/catalog')
        if (signal.aborted || view.key !== currentView.current.key) return
        const available: Environment[] = catalog.projects.flatMap((project: { name: string; environments: { id: string; name: string; permissions: { receive: boolean } }[] }) => project.environments.filter(env => env.permissions.receive).map(env => ({ id: env.id, label: project.name + ' / ' + env.name })))
        setEnvironments(available)
        const environmentChanged = appliedEnvironment.current !== view.environmentId
        appliedEnvironment.current = view.environmentId
        setEnvironmentId(current => {
          const requested = environmentChanged ? view.environmentId ?? '' : current
          return requested || available[0]?.id || ''
        })
        if (view.environmentId && !available.some(env => env.id === view.environmentId)) setError('선택한 환경에 받기 권한이 없어요. 다른 환경을 선택하거나 Owner에게 권한을 요청해주세요.')
      } else {
        const result = await call(base + '/requests' + (view.id ? '/' + view.id : ''))
        if (signal.aborted || view.key !== currentView.current.key) return
        if (view.id && result.id !== view.id) throw new ProRequestError('링크의 요청을 확인할 수 없어요.', 404)
        setItems(view.id ? [result] : result.requests)
      }
      setAccessUnavailable(false)
    } catch (e) {
      if (!signal.aborted && view.key === currentView.current.key) {
        setAccessUnavailable(true)
        // Keep local transfer work on network/server errors, but discard it after confirmed loss of access.
        if (e instanceof ProRequestError && [401, 403, 404, 410].includes(e.status)) {
          if (view.create) { setEnvironments([]); setSenders([]) } else setItems([])
        }
      }
      throw e
    }
  }
  async function run(action: () => Promise<void>) {
    const controller = lifetime.current!
    if (running.current === controller || controller.signal.aborted) return
    running.current = controller; setBusy(true); setError(''); setMessage('')
    try { await action() }
    catch (e) { if (!controller.signal.aborted) setError(e instanceof Error && !(e instanceof TypeError) && e.name !== 'TimeoutError' ? e.message : '서버에 연결하지 못했어요. 같은 작업을 다시 시도할 수 있어요.') }
    finally { if (running.current === controller) running.current = null; if (!controller.signal.aborted) setBusy(false) }
  }
  const refresh = useRef(() => {})
  useLayoutEffect(() => { refresh.current = () => { if (running.current === lifetime.current) return; loadedView.current = currentView.current.key; void run(load) } })
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller
    const reload = () => refresh.current()
    reload(); const stop = subscribeTabReturn(reload)
    return () => { controller.abort(); stop() }
  }, [api, orgId, userId, csrf])
  useEffect(() => { if (!busy && loadedView.current !== routeKey) refresh.current() }, [routeKey, busy])
  useEffect(() => {
    const controller = new AbortController()
    const environmentChanged = senderEnvironment.current !== environmentId
    senderEnvironment.current = environmentId
    setSenders([]); if (environmentChanged) setSenderId(''); setChoosing(!!environmentId && !!route.create)
    if (environmentId && route.create) void call(base + '/requests/options?environmentId=' + environmentId, undefined, AbortSignal.any([controller.signal, lifetime.current!.signal]))
      .then(value => { if (!controller.signal.aborted) { setSenders(value.senders); setSenderId(current => current || value.senders[0]?.id || '') } })
      .catch(e => { if (!controller.signal.aborted && !lifetime.current?.signal.aborted) setError(e instanceof Error ? e.message : '송신자를 불러오지 못했어요.') })
      .finally(() => { if (!controller.signal.aborted) setChoosing(false) })
    return () => controller.abort()
    // The component is scoped to the current organization/account/session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, orgId, csrf, environmentId, environments, route.create])

  async function mutate(path: string, body: Record<string, unknown>) {
    if (path === base + '/requests' && !acceptNewTransfers) throw new Error(betaClosedMessage)
    const signal = lifetime.current!.signal, key = JSON.stringify([path, body])
    const operationId = operations.current.get(key) ?? crypto.randomUUID(); operations.current.set(key, operationId)
    const result: Item = await call(path, { ...body, operationId })
    signal.throwIfAborted()
    if (path === base + '/requests') setItems([result]); else await load()
    operations.current.delete(key)
    if (!signal.aborted) setMessage('요청 상태를 확인했어요.')
    return result
  }
  const shown = detailId ? items.filter(item => item.id === detailId) : items
  return <section className="pro-requests" aria-label="요청함" aria-busy={busy || disabled}>
    <header className="pro-page-header"><div><h2>{route.create ? '파일 요청 만들기' : detailId ? '요청 상세' : '요청함'}</h2><p>{route.create ? '필요한 환경과 파일을 가진 팀원을 선택하세요.' : detailId ? '승인 상태를 확인하고 이 요청의 파일을 주고받으세요.' : '팀원에게 받은 요청과 내가 보낸 요청을 확인하세요.'}</p></div>
      <div className="actions">{(detailId || route.create) ? <a className="button" href={proPath(listRoute)} onClick={event => followProLink(event, listRoute, onNavigate)}>요청 목록</a> : <a className="button primary" href={proPath(createRoute)} onClick={event => followProLink(event, createRoute, onNavigate)}>새 파일 요청</a>}
        <button className="button" type="button" disabled={busy || disabled} onClick={() => refresh.current()}>새로고침</button></div>
    </header>
    {route.create && !acceptNewTransfers && <Notice>{betaClosedMessage}</Notice>}
    {error && <Notice error>{error}</Notice>}
    {accessUnavailable && !!shown.length && !route.create && <Notice>현재 요청 상태를 확인하지 못해 작업을 잠갔어요. 선택한 파일은 유지되며, 새로고침에 성공하면 계속할 수 있어요.</Notice>}
    <p className="pro-status-line" role="status">{busy ? '요청을 확인하고 있어요.' : choosing ? '요청 가능한 멤버를 확인하고 있어요.' : message}</p>
    {route.create ? <fieldset className="plain-fieldset pro-form-panel" disabled={busy || disabled || accessUnavailable}>
      <legend>팀원에게 파일 요청</legend>
      <p>처음 받는 브라우저라면 <a href={proPath({page:'settings',orgId})} onClick={event => followProLink(event,{page:'settings',orgId},onNavigate)}>내 기기 등록·승인</a>을 먼저 완료해주세요.</p>
      {environments.length > 0 ? <form className="pro-form" onSubmit={event => { event.preventDefault(); void run(async () => {
        const device = await loadLocalDevice(userId)
        if (!device) throw new Error('계정·기기 화면에서 이 브라우저를 먼저 등록해주세요.')
        if (lifetime.current?.signal.aborted) return
        const result = await mutate(base + '/requests', { environmentId, senderId, deviceId: device.deviceId })
        if (!lifetime.current?.signal.aborted) onNavigate({ page: 'requests', orgId, id: result.id })
      }) }}>
        <div className="pro-field"><label htmlFor="request-environment">요청할 환경</label><select id="request-environment" value={environmentId} required onChange={e => { setEnvironmentId(e.target.value); setSenders([]); setSenderId('') }}>
          {!environmentId && <option value="" disabled>환경을 선택해주세요</option>}{environmentId && !environments.some(env => env.id === environmentId) && <option value={environmentId} disabled>선택한 환경을 사용할 수 없어요. 다시 선택해주세요.</option>}{environments.map(env => <option value={env.id} key={env.id}>{env.label}</option>)}
        </select></div>
        <div className="pro-field"><label htmlFor="request-sender">요청할 멤버</label><select id="request-sender" value={senderId} onChange={e => setSenderId(e.target.value)} disabled={choosing || !senders.length} required>{senderId && !senders.some(sender => sender.id === senderId) && <option value={senderId} disabled>선택한 멤버에게 요청할 수 없어요. 다시 선택해주세요.</option>}{senders.map(sender => <option value={sender.id} key={sender.id}>{sender.login}</option>)}</select></div>
        {!choosing && !senders.length && <p>이 환경에서 보내기 권한이 있는 다른 멤버가 없어요.</p>}
        <p>파일 보유 여부는 상대에게 확인해주세요. 요청은 7일 동안 유효하며, 이 브라우저의 기기로 고정돼요.</p>
        <button className="button primary" disabled={!acceptNewTransfers || choosing || !senders.some(sender => sender.id === senderId) || !environments.some(env => env.id === environmentId)} type="submit">파일 요청</button>
      </form> : !busy && <Notice>받기 권한이 있는 환경이 없어요. Owner에게 권한을 요청해주세요.</Notice>}
    </fieldset> : <>
      {!detailId && <p>진행 중인 요청부터 최근 100개까지 표시해요. 요청을 열어 승인하거나 파일을 주고받을 수 있어요.</p>}
      {!busy && !shown.length && !error && <div className="pro-empty-state"><h3>{detailId ? '요청을 찾을 수 없어요' : '아직 주고받은 요청이 없어요'}</h3><p>{detailId ? '원래 링크와 현재 계정을 확인해주세요.' : '새 파일 요청을 눌러 필요한 환경과 팀원을 선택하세요.'}</p></div>}
      <div className={detailId ? 'pro-detail' : 'pro-list'}>{shown.map(item => {
        const destination: ProRoute = { page: 'requests', orgId, id: item.id }
        return <article className="pro-project" key={item.id}>
          <h3>{detailId ? (item.project ? item.project + ' / ' + item.environment : '종료된 요청') : <a href={proPath(destination)} onClick={event => followProLink(event, destination, onNavigate)}>{item.project ? item.project + ' / ' + item.environment : item.status === 'fulfilled' ? '전달된 요청' : '종료된 요청'}</a>}</h3>
          <p className="pro-item-meta">{item.direction === 'incoming' ? '받은 요청' : item.direction === 'outgoing' ? '내가 보낸 요청' : '관리 중인 요청'} <strong className="pro-badge" data-status={item.status}>{statuses[item.status] ?? '상태 확인 필요'}</strong></p>
          {item.sender && <p>요청한 사람 {item.receiver} · 파일 보낼 사람 {item.sender}</p>}
          <p className="pro-item-meta">요청일 {new Date(item.createdAt).toLocaleString('ko-KR')} · 요청 기한 {new Date(item.expiresAt).toLocaleString('ko-KR')}</p>
          {item.transfer && <p>전달: {item.transfer.status === 'available' ? '다운로드 가능' : item.transfer.status === 'revoked' ? '회수됨' : '만료됨'} · {new Date(item.transfer.expiresAt).toLocaleString()}까지 · {item.transfer.acknowledgedAt ? '수신 확인됨' : '수신 확인 전'}</p>}
          {detailId ? <>
            <details><summary>요청 식별 정보</summary><CopyField label="요청 상세 링크 (로그인 필요)" value={location.origin + proPath(destination)} /><p className="device-id">{item.id}</p>{item.receiverDeviceId && <p className="device-id">수신 기기: {item.receiverDeviceId}</p>}</details>
            <fieldset className="plain-fieldset" disabled={busy || disabled || accessUnavailable}><legend>요청 처리</legend><div className="actions">
              {item.status === 'pending' && item.direction === 'incoming' && <><button className="button primary" type="button" onClick={() => { void run(async () => { await mutate(base + '/requests/' + item.id + '/approve', {}) }) }}>승인</button><button className="button" type="button" onClick={() => { if (window.confirm('이 파일 요청을 거절할까요?')) void run(async () => { await mutate(base + '/requests/' + item.id + '/reject', {}) }) }}>거절</button></>}
              {['pending', 'approved'].includes(item.status) && <button className="button pro-danger" type="button" onClick={() => { if (window.confirm('이 요청을 취소할까요? 다시 받으려면 새 요청이 필요해요.')) void run(async () => { await mutate(base + '/requests/' + item.id + '/cancel', {}) }) }}>요청 취소</button>}
            </div>
            {((item.status === 'approved' && item.direction === 'incoming') || (item.transfer?.status === 'available' && item.direction === 'outgoing')) && <ProTransfer acceptNewTransfers={acceptNewTransfers} key={item.id + (item.transfer?.status ?? item.status)} api={api} orgId={orgId} requestId={item.id} userId={userId} csrf={csrf} sending={item.status === 'approved'} project={item.project ?? ''} environment={item.environment ?? ''} onDone={load} onExpired={onExpired} onNavigate={onNavigate} />}
            {item.transfer?.status === 'available' && <button className="button" type="button" onClick={() => { if (window.confirm('전달을 회수할까요? 이후 다운로드를 차단하며 이미 받은 사본은 지워지지 않아요.')) void run(async () => { await mutate(base + '/requests/' + item.id + '/transfer/revoke', {}) }) }}>전달 회수</button>}
            </fieldset>
          </> : <a className="button" href={proPath(destination)} onClick={event => followProLink(event, destination, onNavigate)}>요청 열기</a>}
        </article>
      })}</div>
    </>}
  </section>
}

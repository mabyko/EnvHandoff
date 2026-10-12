import { proRequest } from '../lib/pro-api.ts'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ProTransfer } from './ProTransfer.tsx'
import { betaClosedMessage, ProRequestError, subscribeTabReturn } from '../lib/pro-feedback.ts'
import { CopyField, Notice, Steps } from './ui.tsx'
import { followProLink, proPath } from '../lib/pro-navigation.ts'
import type { ProRoute } from '../lib/pro-navigation.ts'
import { loadLocalDevice } from '../lib/device-keys.ts'

type Item = { id: string; status: string; direction: string; createdAt: number; expiresAt: number; project?: string; environment?: string; sender?: string; receiver?: string; receiverDeviceId?: string; transfer?: { id: string; status: string; expiresAt: number; acknowledgedAt: number | null } }
type Environment = { id: string; label: string }
type Sender = { id: string; login: string }
export type RequestDraft = { environmentId: string; senderId: string }
const requestGroups = ['내가 처리할 일', '상대 대기', '종료'] as const
function requestTask(item: Item) {
  if (['rejected', 'cancelled', 'expired'].includes(item.status) || (item.status === 'fulfilled' && item.transfer?.status !== 'available')) return { group: '종료', action: '종료 내역 확인', hint: '이 요청으로는 더 받을 수 없어요. 다시 필요하면 새 파일 요청을 만드세요.', step: -1 }
  if (item.transfer?.acknowledgedAt) return { group: '종료', action: item.direction === 'outgoing' && item.transfer.status === 'available' ? '다시 받기' : '수신 내역 확인', hint: '수신 기기의 파일 검사가 완료됐어요. 프로젝트 적용 여부를 뜻하지는 않아요.', step: 4 }
  if (item.status === 'pending' && item.direction === 'incoming') return { group: '내가 처리할 일', action: '요청 확인·승인', hint: '내 차례예요. 파일을 보낼 수 있는지 확인하고 승인하거나 거절하세요.', step: 1 }
  if (item.status === 'approved' && item.direction === 'incoming') return { group: '내가 처리할 일', action: '파일 준비·보내기', hint: '내 차례예요. 상대 기기를 확인하고 보낼 파일을 준비하세요.', step: 2 }
  if (item.transfer?.status === 'available' && item.direction === 'outgoing') return { group: '내가 처리할 일', action: '파일 받기', hint: '내 차례예요. 요청을 만든 브라우저에서 파일을 받을 수 있어요.', step: 3 }
  return { group: '상대 대기', action: '진행 상태 확인', hint: item.direction === 'incoming' ? `${item.receiver ?? '요청한 팀원'}의 수신을 기다리고 있어요.` : item.direction === 'outgoing' ? `${item.sender ?? '파일을 보낼 팀원'}의 ${item.status === 'pending' ? '승인을' : '파일 준비를'} 기다리고 있어요. 상세 링크로 현재 요청을 알려주세요.` : '참여 팀원이 처리 중이에요. 관리 조회에서는 파일을 받을 수 없어요.', step: item.status === 'pending' ? 1 : item.status === 'approved' ? 2 : 3 }
}
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

export function ProRequests({ api, orgId, userId, csrf, targetId, route, onNavigate, disabled, acceptNewTransfers = true, onExpired, draft, onPrepareDevice, onRequestCreated }: { api: string; orgId: string; userId: string; csrf: string; targetId?: string; route: ProRoute; onNavigate: (route: ProRoute) => void; disabled: boolean; acceptNewTransfers?: boolean; onExpired: () => void; draft?: RequestDraft; onPrepareDevice?: (draft: RequestDraft) => void; onRequestCreated?: () => void }) {
  const detailId = route.id ?? targetId
  const routeKey = JSON.stringify([detailId, route.create, route.environmentId])
  const currentView = useRef({ id: detailId, create: route.create, environmentId: route.environmentId, key: routeKey })
  useLayoutEffect(() => { currentView.current = { id: detailId, create: route.create, environmentId: route.environmentId, key: routeKey } })
  const initialDraft = draft && (!route.environmentId || draft.environmentId === route.environmentId) ? draft : undefined
  const loadedView = useRef(''), appliedEnvironment = useRef(route.environmentId), senderEnvironment = useRef(initialDraft?.environmentId ?? '')
  const [items, setItems] = useState<Item[]>([]), [environments, setEnvironments] = useState<Environment[]>([])
  const [environmentId, setEnvironmentId] = useState(route.environmentId ?? initialDraft?.environmentId ?? ''), [senders, setSenders] = useState<Sender[]>([]), [senderId, setSenderId] = useState(initialDraft?.senderId ?? '')
  const [deviceStatus, setDeviceStatus] = useState('checking')
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
  async function checkDevice() {
    const [local, security] = await Promise.all([loadLocalDevice(userId), call('/security')])
    const registered = local ? security.devices.find((device: { identity: { deviceId: string }; status: string }) => device.identity.deviceId === local.deviceId) : undefined
    return { deviceId: local?.deviceId, status: registered?.status ?? 'unregistered' }
  }
  async function load() {
    const signal = lifetime.current!.signal, view = currentView.current
    try {
      if (view.create) {
        const [catalog, device] = await Promise.all([call(base + '/catalog'), checkDevice()])
        if (signal.aborted || view.key !== currentView.current.key) return
        setDeviceStatus(device.status)
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
      .then(value => { if (!controller.signal.aborted) setSenders(value.senders) })
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
    <header className="pro-page-header"><div><h2>{route.create ? '파일 요청 만들기' : detailId ? '요청 상세' : '요청함'}</h2><p>{route.create ? '필요한 환경과 요청할 팀원을 선택하세요.' : detailId ? '승인 상태를 확인하고 이 요청의 파일을 주고받으세요.' : '팀원에게 받은 요청과 내가 보낸 요청을 확인하세요.'}</p></div>
      <div className="actions">{(detailId || route.create) ? <a className="button" href={proPath(listRoute)} onClick={event => followProLink(event, listRoute, onNavigate)}>요청 목록</a> : <a className="button primary" href={proPath(createRoute)} onClick={event => followProLink(event, createRoute, onNavigate)}>새 파일 요청</a>}
        <button className="button" type="button" disabled={busy || disabled} onClick={() => refresh.current()}>새로고침</button></div>
    </header>
    {route.create && !acceptNewTransfers && <Notice>{betaClosedMessage}</Notice>}
    {error && <Notice error>{error}</Notice>}
    {accessUnavailable && !!shown.length && !route.create && <Notice>현재 요청 상태를 확인하지 못해 작업을 잠갔어요. 선택한 파일은 유지되며, 새로고침에 성공하면 계속할 수 있어요.</Notice>}
    <p className="pro-status-line" role="status">{busy ? '요청을 확인하고 있어요.' : choosing ? '요청 가능한 멤버를 확인하고 있어요.' : message}</p>
    {route.create ? <fieldset className="plain-fieldset pro-form-panel" disabled={busy || disabled || accessUnavailable}>
      <legend>팀원에게 파일 요청</legend>
      {!busy && !accessUnavailable && <Notice>{deviceStatus === 'active' ? '이 브라우저는 파일을 받을 준비가 됐어요.' : deviceStatus === 'pending' ? '이 브라우저는 기존 기기의 승인 대기 중이에요. 기존 기기에서 지문을 대조하고 승인한 뒤 새로고침해주세요.' : deviceStatus === 'revoked' ? '이 브라우저의 등록이 회수됐어요. 내 설정에서 기기 상태를 확인해주세요.' : '파일을 받을 브라우저를 먼저 등록해주세요. 환경과 멤버 선택은 기기 준비 후 이어갈 수 있어요.'}
        {deviceStatus !== 'active' && <a className="button primary" href={proPath({page:'settings',orgId})} onClick={event => { if (onPrepareDevice && !event.button && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onPrepareDevice({environmentId,senderId}) } else followProLink(event,{page:'settings',orgId},onNavigate) }}>{deviceStatus === 'pending' ? '기기 승인 안내 보기' : '이 브라우저 준비하기'}</a>}
      </Notice>}
      {environments.length > 0 ? <form className="pro-form" onSubmit={event => { event.preventDefault(); void run(async () => {
        const device = await checkDevice()
        if (lifetime.current?.signal.aborted) return
        setDeviceStatus(device.status)
        if (device.status !== 'active') throw new Error(errors.device_required)
        if (lifetime.current?.signal.aborted) return
        const result = await mutate(base + '/requests', { environmentId, senderId, deviceId: device.deviceId })
        if (!lifetime.current?.signal.aborted) { onRequestCreated?.(); onNavigate({ page: 'requests', orgId, id: result.id }) }
      }) }}>
        <div className="pro-field"><label htmlFor="request-environment">요청할 환경</label><select id="request-environment" value={environmentId} required onChange={e => { setEnvironmentId(e.target.value); setSenders([]); setSenderId('') }}>
          {!environmentId && <option value="" disabled>환경을 선택해주세요</option>}{environmentId && !environments.some(env => env.id === environmentId) && <option value={environmentId} disabled>선택한 환경을 사용할 수 없어요. 다시 선택해주세요.</option>}{environments.map(env => <option value={env.id} key={env.id}>{env.label}</option>)}
        </select></div>
        <div className="pro-field"><label htmlFor="request-sender">요청할 멤버</label><select id="request-sender" value={senderId} onChange={e => setSenderId(e.target.value)} disabled={choosing || !senders.length} required><option value="" disabled>파일을 가진 멤버를 선택해주세요</option>{senderId && !senders.some(sender => sender.id === senderId) && <option value={senderId} disabled>선택한 멤버에게 요청할 수 없어요. 다시 선택해주세요.</option>}{senders.map(sender => <option value={sender.id} key={sender.id}>{sender.login}</option>)}</select></div>
        {!choosing && !senders.length && <Notice>이 환경에서 보내기 권한이 있는 다른 멤버가 없어요.<CopyField label="Owner에게 보낼 안내" value={`${environments.find(env => env.id === environmentId)?.label ?? '선택한 환경'}에서 파일을 요청하려는데 보내기 가능한 다른 멤버가 없어요. 파일을 가진 팀원의 프로젝트 참여와 보내기 권한을 확인해주세요.`} /></Notice>}
        <p>파일 보유 여부는 상대에게 확인해주세요. 요청은 7일 동안 유효하며, 이 브라우저의 기기로 고정돼요.</p>
        <button className="button primary" disabled={!acceptNewTransfers || deviceStatus !== 'active' || choosing || !senders.some(sender => sender.id === senderId) || !environments.some(env => env.id === environmentId)} type="submit">파일 요청</button>
      </form> : !busy && !accessUnavailable && <Notice>받기 권한이 있는 환경이 없어요. 프로젝트 참여와 받기 권한을 Owner에게 확인해주세요.<CopyField label="Owner에게 보낼 안내" value="워크스페이스에 참여했지만 파일을 요청할 수 있는 환경이 없어요. 제 팀의 프로젝트 연결, 환경 등록, 프로젝트 기본 받기 권한과 환경별 예외를 확인해주세요." /><a className="button" href={proPath({page:'projects',orgId})} onClick={event => followProLink(event,{page:'projects',orgId},onNavigate)}>프로젝트 확인</a></Notice>}
    </fieldset> : <>
      {!detailId && <p>진행 중인 요청부터 최근 100개까지 표시해요. 요청을 열어 승인하거나 파일을 주고받을 수 있어요.</p>}
      {!busy && !shown.length && !error && <div className="pro-empty-state"><h3>{detailId ? '요청을 찾을 수 없어요' : '아직 주고받은 요청이 없어요'}</h3><p>{detailId ? '원래 링크와 현재 계정을 확인해주세요.' : '새 파일 요청을 눌러 필요한 환경과 팀원을 선택하세요.'}</p></div>}
      {(detailId ? ['상세'] : requestGroups).map(group => {
        const grouped = detailId ? shown : shown.filter(item => requestTask(item).group === group)
        if (!grouped.length) return null
        return <section key={group} aria-label={detailId ? '요청 상세 내용' : group}>{!detailId && <h3>{group} · {grouped.length}건</h3>}<div className={detailId ? 'pro-detail' : 'pro-list'}>{grouped.map(item => {
        const destination: ProRoute = { page: 'requests', orgId, id: item.id }
        const task = requestTask(item)
        return <article className="pro-project" key={item.id}>
          <h3>{detailId ? (item.project ? item.project + ' / ' + item.environment : '종료된 요청') : <a href={proPath(destination)} onClick={event => followProLink(event, destination, onNavigate)}>{item.project ? item.project + ' / ' + item.environment : item.status === 'fulfilled' ? '전달된 요청' : '종료된 요청'}</a>}</h3>
          <p className="pro-item-meta">{item.direction === 'incoming' ? '받은 요청' : item.direction === 'outgoing' ? '내가 보낸 요청' : '관리 중인 요청'} <strong className="pro-badge" data-status={item.status}>{statuses[item.status] ?? '상태 확인 필요'}</strong></p>
          {item.sender && <p>요청한 사람 {item.receiver} · 파일 보낼 사람 {item.sender}</p>}
          <p>{task.hint}</p>
          <p className="pro-item-meta">요청일 {new Date(item.createdAt).toLocaleString('ko-KR')} · 요청 기한 {new Date(item.expiresAt).toLocaleString('ko-KR')}</p>
          {item.transfer && <p>전달: {item.transfer.status === 'available' ? '다운로드 가능' : item.transfer.status === 'revoked' ? '회수됨' : '만료됨'} · {new Date(item.transfer.expiresAt).toLocaleString()}까지 · {item.transfer.acknowledgedAt ? '수신 확인됨' : '수신 확인 전'}</p>}
          {detailId ? <>
            {task.step >= 0 && <Steps labels={['요청', '승인', '파일 준비', '받기']} current={task.step} />}
            {task.group === '상대 대기' && <CopyField label="팀원에게 전달할 요청 상세 링크 (로그인 필요)" value={location.origin + proPath(destination)} />}
            <details><summary>요청 식별 정보</summary>{task.group !== '상대 대기' && <CopyField label="요청 상세 링크 (로그인 필요)" value={location.origin + proPath(destination)} />}<p className="device-id">{item.id}</p>{item.receiverDeviceId && <p className="device-id">수신 기기: {item.receiverDeviceId}</p>}</details>
            <fieldset className="plain-fieldset" disabled={busy || disabled || accessUnavailable}><legend>요청 처리</legend><div className="actions">
              {item.status === 'pending' && item.direction === 'incoming' && <><button className="button primary" type="button" onClick={() => { void run(async () => { await mutate(base + '/requests/' + item.id + '/approve', {}) }) }}>승인</button><button className="button" type="button" onClick={() => { if (window.confirm('이 파일 요청을 거절할까요?')) void run(async () => { await mutate(base + '/requests/' + item.id + '/reject', {}) }) }}>거절</button></>}
              {['pending', 'approved'].includes(item.status) && <button className="button pro-danger" type="button" onClick={() => { if (window.confirm('이 요청 전체를 종료할까요? 진행 중인 업로드도 확정할 수 없게 되며 다시 받으려면 새 요청이 필요해요.')) void run(async () => { await mutate(base + '/requests/' + item.id + '/cancel', {}) }) }}>요청 전체 취소</button>}
            </div>
            {((item.status === 'approved' && item.direction === 'incoming') || (item.transfer?.status === 'available' && item.direction === 'outgoing')) && <ProTransfer acceptNewTransfers={acceptNewTransfers} key={item.id + (item.transfer?.status ?? item.status)} api={api} orgId={orgId} requestId={item.id} userId={userId} csrf={csrf} sending={item.status === 'approved'} project={item.project ?? ''} environment={item.environment ?? ''} peerLabel={item.direction === 'incoming' ? item.receiver : item.sender} onDone={load} onExpired={onExpired} onNavigate={onNavigate} />}
            {item.transfer?.status === 'available' && <button className="button" type="button" onClick={() => { if (window.confirm('전달을 회수할까요? 이후 다운로드를 차단하며 이미 받은 사본은 지워지지 않아요.')) void run(async () => { await mutate(base + '/requests/' + item.id + '/transfer/revoke', {}) }) }}>전달 회수</button>}
            </fieldset>
            {task.step === -1 && item.direction === 'outgoing' && <a className="button primary" href={proPath(createRoute)} onClick={event => followProLink(event,createRoute,onNavigate)}>새 파일 요청</a>}
          </> : <a className={'button' + (task.group === '내가 처리할 일' ? ' primary' : '')} href={proPath(destination)} onClick={event => followProLink(event, destination, onNavigate)}>{task.action}</a>}
        </article>
      })}</div></section>})}
    </>}
  </section>
}

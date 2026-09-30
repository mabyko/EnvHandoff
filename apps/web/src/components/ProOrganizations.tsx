import { Check, ChevronDown, Plus, Inbox, Folder, Link, Users, Building2, KeyRound } from 'lucide-react'
import { ProBeta } from './ProBeta.tsx'
import type { BetaStatus } from './ProBeta.tsx'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { limitMessage, subscribeTabReturn } from '../lib/pro-feedback.ts'
import { CopyField, Notice } from './ui.tsx'
import { invitationToken } from '../lib/invitation.ts'
import { ProRequests } from './ProRequests.tsx'
import { ProCatalog } from './ProCatalog.tsx'
import { ProShares } from './ProShares.tsx'
import { followProLink, proPath } from '../lib/pro-navigation.ts'
import type { ProRoute } from '../lib/pro-navigation.ts'

type Organization = { id: string; name: string; role: 'owner' | 'member'; active: number }
type Detail = { id: string; name: string; role: 'owner' | 'member'; teams: { id: string; name: string }[]; members: { id: string; login: string; role: string }[]; invitations: { id: string; login: string; expiresAt: number }[] }
type Preview = { kind: 'owner' | 'member'; login: string; organization: string | null; team: string | null; accepted: boolean }
const errors: Record<string, string> = {
  beta_required: '베타 코드를 입력해 Pro Beta를 활성화해주세요.',
  workspace_limit: '소유 워크스페이스는 최대 2개예요. 목록을 새로고침해주세요.',
  beta_code_unavailable: '코드를 확인해주세요. 만료·취소됐거나 참여 인원이 마감된 코드일 수 있어요.',
  invalid_beta_code: '이름은 1~80자, 인원은 1~1,000명, 유효 일수는 1~365일로 입력해주세요.',
  operator_required: '운영자만 이용할 수 있어요.',
  wrong_github_account: '이 초대는 다른 GitHub 계정용이에요. 로그아웃한 뒤 초대받은 계정으로 로그인해주세요.',
  invitation_unavailable: '만료되거나 취소된 초대예요. 새 초대를 요청해주세요.',
  organization_inactive: '이 워크스페이스의 베타 참여가 중지됐어요. 운영자에게 문의해주세요.',
  organization_not_found: '워크스페이스에 접근할 수 없어요. 목록을 새로고침해주세요.',
  owner_required: '워크스페이스 Owner만 할 수 있는 작업이에요.',
  last_owner: '마지막 Owner는 역할을 바꾸거나 탈퇴할 수 없어요. 먼저 다른 Owner를 지정해주세요.',
  reauthentication_required: '설정에서 패스키 또는 인증 앱으로 본인 확인 후 다시 시도해주세요.',
  github_account_not_found: 'GitHub 계정을 찾지 못했어요. 계정 이름을 확인해주세요.',
  invalid_github_account: '개인 GitHub 계정 이름을 입력해주세요.',
  invalid_github_login: 'GitHub 계정 이름을 확인해주세요.',
  invalid_name: '이름은 공백을 제외해 1~80자로 입력해주세요.',
  member_limit: '워크스페이스는 최대 20명까지 가입할 수 있어요.',
  invite_limit: '초대 한도에 도달했어요. 대기 중인 초대를 정리하거나 잠시 후 다시 시도해주세요.',
  already_accepted: '이미 수락한 초대예요. 멤버 목록에서 확인해주세요.',
  csrf_failed: '로그인 상태가 바뀌었어요. 새로고침 후 다시 시도해주세요.',
}

export function ProOrganizations({ api, userId, csrf, initialToken, route, onNavigate: navigate, onResolvedOrganization, settings, disabled, onExpired, onAccepted }: { api: string; userId: string; csrf: string; initialToken: string; route: ProRoute; onNavigate: (route: ProRoute) => void; onResolvedOrganization: (orgId: string) => void; settings: ReactNode; disabled: boolean; onExpired: () => void; onAccepted: () => void }) {
  const lifetime = useRef<AbortController | null>(null), running = useRef<AbortController | null>(null)
  const refresh = useRef(() => {})
  const [accessUnavailable, setAccessUnavailable] = useState(false)
  const locked = disabled || accessUnavailable
  const loadedOrganization = useRef('')
  const [beta, setBeta] = useState<BetaStatus | null>(null)
  const [newName, setNewName] = useState('')
  const memberInvite = useRef<HTMLDetailsElement>(null)
  const createDialog = useRef<HTMLDialogElement>(null), switcher = useRef<HTMLDetailsElement>(null)
  function openCreate() {
    if (switcher.current) switcher.current.open = false
    setNewName(''); setError(''); createDialog.current?.showModal()
  }
  useEffect(() => {
    const close = (event: PointerEvent) => { if (switcher.current && !switcher.current.contains(event.target as Node)) switcher.current.open = false }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])
  const [organizations, setOrganizations] = useState<Organization[]>([])
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [inviteInput, setInviteInput] = useState(initialToken ? location.origin + '/pro#invite=' + initialToken : '')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [workspaceName, setWorkspaceName] = useState('')
  const [login, setLogin] = useState('')
  const [teamId, setTeamId] = useState('')
  const [createdLink, setCreatedLink] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [removing, setRemoving] = useState<{ id: string; login: string } | null>(null)
  const [change, setChange] = useState<{ question: string; path: string; body: Record<string, unknown> } | null>(null)
  function onNavigate(next: ProRoute) { setError(''); setMessage(''); navigate(next) }
  const inviteTeamId = detail?.teams.find((team) => team.id === teamId)?.id ?? detail?.teams[0]?.id ?? ''
  const nav = (page: ProRoute['page']): ProRoute => ({ page, ...(selected ? { orgId: selected } : {}) })
  const workspaceRoute = (orgId: string): ProRoute => orgId === selected ? { ...route, orgId } : { page: route.page === 'start' ? 'requests' : route.page, orgId }
  const expired = useRef(onExpired)
  useEffect(() => { expired.current = onExpired }, [onExpired])
  const resolved = useRef(onResolvedOrganization)
  useEffect(() => { resolved.current = onResolvedOrganization }, [onResolvedOrganization])

  async function call(path: string, body?: Record<string, unknown>, signal = AbortSignal.timeout(15_000)) {
    const controller = lifetime.current!
    const response = await fetch(api + path, { method: body ? 'POST' : 'GET', credentials: 'include', redirect: 'error', signal: AbortSignal.any([signal, controller.signal]),
      headers: body ? { 'content-type': 'application/json', 'x-csrf-token': csrf } : {}, body: body ? JSON.stringify(body) : undefined })
    if (response.status === 401) { if (!controller.signal.aborted) expired.current(); throw new Error('로그인이 만료됐어요. 다시 로그인해주세요.') }
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      if (!controller.signal.aborted && ['organization_not_found','organization_inactive'].includes(data.error)) setDetail(null)
      const fallback = path.startsWith('/beta/codes')
        ? body ? '코드 처리 결과를 확인하지 못했어요. 아래 발급 내역을 확인한 뒤 다시 시도해주세요.' : '발급 내역을 불러오지 못했어요. 아래 새로고침 버튼으로 다시 확인해주세요.'
        : path === '/security' ? '본인 확인 상태를 불러오지 못했어요. 발급 내역의 새로고침으로 다시 확인해주세요.' : '요청을 완료하지 못했어요. 새로고침 후 다시 시도해주세요.'
      throw new Error(response.status === 429 ? limitMessage(data.error as string,response.headers.get('retry-after')) : errors[data.error as string] ?? fallback)
    }
    controller.signal.throwIfAborted()
    return data
  }
  async function load(orgId = selected) {
    const controller = lifetime.current!
    const items: Organization[] = await call('/organizations')
    setBeta(await call('/beta'))
    const next = orgId ? items.find((org) => org.id === orgId && org.active) : items.find((org) => org.active)
    setOrganizations(items); setSelected(next?.id ?? '')
    if (orgId && !next) { setDetail(null); throw new Error('이 워크스페이스에 접근할 수 없어요. 다른 워크스페이스를 선택해주세요.') }
    const value: Detail | null = next ? await call('/organizations/' + next.id) : null
    if (controller.signal.aborted) return
    loadedOrganization.current = JSON.stringify([api,userId,csrf,value?.id])
    setDetail(value); setTeamId(value?.teams[0]?.id ?? ''); setAccessUnavailable(false)
  }
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    const start = async () => {
      // Adding the already selected organization to the URL must not unmount in-memory shares.
      if (route.orgId && loadedOrganization.current === JSON.stringify([api,userId,csrf,route.orgId])) { setBusy(false); return }
      loadedOrganization.current = ''
      setBusy(true); setDetail(null); setError(''); setMessage(''); setCreatedLink(''); setRemoving(null); setChange(null)
      try {
        const response = await fetch(api + '/organizations', { credentials: 'include', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
        if (response.status === 401) { expired.current(); throw new Error('로그인이 만료됐어요. 새로고침해주세요.') }
        if (!response.ok) throw new Error('워크스페이스 목록을 불러오지 못했어요. 새로고침해주세요.')
        const items: Organization[] = await response.json()
        if (controller.signal.aborted) return
        const betaResponse = await fetch(api + '/beta', { credentials: 'include', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
        if (!betaResponse.ok) throw new Error('베타 참여 상태를 불러오지 못했어요. 새로고침해주세요.')
        const betaStatus: BetaStatus = await betaResponse.json()
        if (controller.signal.aborted) return
        setBeta(betaStatus)
        setOrganizations(items)
        const next = route.orgId ? items.find(org => org.id === route.orgId && org.active) : items.find((org) => org.active)
        if (route.orgId && !next) { setSelected(''); throw new Error('링크의 워크스페이스에 접근할 수 없어요. 현재 계정과 참여 권한을 확인해주세요.') }
        setSelected(next?.id ?? '')
        if (next) {
          const response = await fetch(api + '/organizations/' + next.id, { credentials: 'include', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
          if (!response.ok) throw new Error('워크스페이스를 불러오지 못했어요. 새로고침해주세요.')
          const value: Detail = await response.json()
          if (!controller.signal.aborted) { loadedOrganization.current = JSON.stringify([api,userId,csrf,value.id]); setDetail(value); setTeamId(value.teams[0]?.id ?? ''); setAccessUnavailable(false); if (!route.orgId) resolved.current(value.id) }
        }
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '목록을 불러오지 못했어요.') }
      finally { if (!controller.signal.aborted) setBusy(false) }
    }
    void start(); const stop = subscribeTabReturn(() => refresh.current())
    return () => { controller.abort(); stop() }
  }, [api, userId, csrf, route.orgId])

  async function run(action: () => Promise<void>) {
    const controller = lifetime.current!
    if (running.current === controller || controller.signal.aborted) return
    running.current = controller
    setBusy(true); setError(''); setMessage('')
    try { await action() } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error && !(error instanceof TypeError) && error.name !== 'TimeoutError' ? error.message : '서버에 연결하지 못했어요. 잠시 후 다시 시도해주세요.') }
    finally { if (running.current === controller) running.current = null; if (!controller.signal.aborted) setBusy(false) }
  }
  useLayoutEffect(() => { refresh.current = () => { if (busy) return; const controller = lifetime.current!; void run(async () => { try { await load(route.orgId ?? selected) } catch (error) { if (!controller.signal.aborted) setAccessUnavailable(true); throw error } }) } })
  async function checkInvite() {
    const token = invitationToken(inviteInput, location.origin)
    if (!token) throw new Error('워크스페이스 초대 링크를 확인해주세요. 베타 참여 코드는 ‘베타 코드 입력하기’에서 입력할 수 있어요.')
    try { sessionStorage.setItem('envhandoff-invitation', token) } catch { /* Pasting again after login remains available. */ }
    setPreview(await call('/organizations/invitations/preview', { token }))
  }

  return (
    <div className="pro-layout" aria-busy={busy || locked}>
      <aside className="pro-sidebar">
        <div className="pro-workspace"><span className="pro-nav-label">워크스페이스</span>
          <details className="pro-switcher" ref={switcher} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
            <summary><span className="pro-workspace-icon"><Building2 aria-hidden="true" /></span><span>{detail?.name ?? '워크스페이스 선택'}<small>{detail ? (detail.role === 'owner' ? 'Owner' : 'Member') : '팀과 함께 시작하세요'}</small></span><ChevronDown aria-hidden="true" /></summary>
            <div className="pro-switcher-options"><p>내 워크스페이스</p>
              {organizations.filter(org => org.active).map(org => <a key={org.id} href={proPath(workspaceRoute(org.id))} aria-current={org.id === selected ? 'true' : undefined} onClick={event => { followProLink(event, workspaceRoute(org.id), onNavigate); if(switcher.current)switcher.current.open=false }}><span>{org.name}<small>{org.role === 'owner' ? 'Owner' : 'Member'}</small></span>{org.id === selected && <Check aria-hidden="true" />}</a>)}
              {!organizations.some(org => org.active) && <p>참여 중인 워크스페이스가 없어요.</p>}
              <div className="pro-switcher-footer"><small>소유 {beta?.owned ?? 0} / {beta?.workspaceLimit ?? 2}개</small>
              {beta?.active ? <button type="button" disabled={busy || locked || beta.owned >= beta.workspaceLimit} onClick={openCreate}><Plus aria-hidden="true" />새 워크스페이스 만들기</button> : <a href={proPath(nav('beta'))} onClick={event => { followProLink(event,nav('beta'),onNavigate); if(switcher.current)switcher.current.open=false }}>Pro Beta 참여하기</a>}
              {beta?.active && beta.owned >= beta.workspaceLimit && <small>베타에서는 최대 2개까지 소유할 수 있어요.</small>}</div>
            </div>
          </details>
        </div>
        {detail && <nav aria-label="워크스페이스 메뉴">{([['requests','요청함',Inbox],['projects','프로젝트',Folder],['shares','외부 공유',Link],['team','멤버 · 팀',Users]] as const).map(([page,label,Icon]) => <a key={page} href={proPath(nav(page))} aria-current={route.page === page ? 'page' : undefined} onClick={event => followProLink(event, nav(page), onNavigate)}><Icon aria-hidden="true" />{label}</a>)}</nav>}
        <div className="pro-sidebar-bottom"><a href={proPath(nav('start'))} aria-current={route.page === 'start' ? 'page' : undefined} onClick={event => followProLink(event, nav('start'), onNavigate)}>워크스페이스 참여</a>
        <a href={proPath(nav('beta'))} aria-current={route.page === 'beta' ? 'page' : undefined} onClick={event => followProLink(event,nav('beta'),onNavigate)}>{beta?.operator ? '베타 참여 관리' : beta?.active ? '내 베타 이용 현황' : 'Pro Beta 참여하기'}</a></div>
      </aside>
      <div className="pro-content" tabIndex={-1} aria-label="워크스페이스 내용">
      {error && <Notice error={error !== errors.reauthentication_required}><span role={error === errors.reauthentication_required ? 'status' : undefined}>{error}</span>{error === errors.reauthentication_required && <button type="button" className="button" onClick={() => onNavigate(nav('settings'))}>내 설정에서 본인 확인</button>}</Notice>}
      {accessUnavailable && <button type="button" className="button" disabled={busy || disabled} onClick={() => refresh.current()}>워크스페이스 상태 다시 확인</button>}
      {message && <p role="status">{message}</p>}
      {busy && <p role="status">워크스페이스를 확인하고 있어요.</p>}
      {route.page === 'start' && <section className="pro-page"><header className="pro-page-header"><div><h2>워크스페이스 참여</h2><p>초대받은 워크스페이스에 참여하거나, 베타 코드로 내 워크스페이스를 만들 수 있어요.</p></div></header>
        {detail && <div className="pro-current-workspace"><div><span className="pro-badge">현재 워크스페이스 · {detail.role === 'owner' ? 'Owner' : 'Member'}</span><h3>{detail.name}</h3><p>이미 참여 중이에요. 아래에서 다른 워크스페이스의 초대도 수락할 수 있어요.</p></div><div className="actions"><a className="button primary" href={proPath(nav('requests'))} onClick={event => followProLink(event, nav('requests'), onNavigate)}>요청함 열기</a>{detail.role === 'owner' && <a className="button" href={proPath(nav('team'))} onClick={event => followProLink(event, nav('team'), onNavigate)}>멤버 초대·관리</a>}<a className="text-button" href={proPath(nav('settings'))} onClick={event => followProLink(event, nav('settings'), onNavigate)}>기기·보안 설정</a></div></div>}
      <div className="pro-join-grid">
      <section className="pro-join-card" aria-labelledby="workspace-invite-title"><div className="pro-join-icon"><Users aria-hidden="true" /></div><span className="pro-badge">워크스페이스 초대 링크</span><h3 id="workspace-invite-title">초대받은 워크스페이스에 참여</h3><p id="workspace-invite-help">워크스페이스 Owner에게 받은 링크를 붙여넣으세요. 베타 코드 없이도 해당 워크스페이스의 멤버로 참여할 수 있어요.</p>
      <fieldset className="plain-fieldset" disabled={busy || locked}>
        <legend className="sr-only">워크스페이스 초대 수락</legend>
        <form className="pro-form" onSubmit={(event) => { event.preventDefault(); void run(checkInvite) }}>
          <label htmlFor="invitation-link">워크스페이스 초대 링크</label>
          <input id="invitation-link" value={inviteInput} aria-describedby="workspace-invite-help" placeholder="https://…/pro#invite=…" autoComplete="off" spellCheck={false} maxLength={1024} required onChange={(event) => { setInviteInput(event.target.value); setPreview(null) }} />
          <button className="button primary" type="submit">{busy ? '확인 중…' : '워크스페이스 초대 확인'}</button>
        </form>
        {preview && <form className="pro-form" onSubmit={(event) => { event.preventDefault(); void run(async () => {
          const result = await call('/organizations/invitations/accept', { token: invitationToken(inviteInput, location.origin), ...(preview.kind === 'owner' ? { name: workspaceName } : {}) })
          try { sessionStorage.removeItem('envhandoff-invitation') } catch { /* No persistent auth state is stored here. */ }
          onAccepted(); setPreview(null); setInviteInput(''); onNavigate({page:'requests',orgId:result.id})
        }) }}>
          <p>{preview.kind === 'owner' ? '새 워크스페이스를 개설하는 초대예요.' : `${preview.organization}에 참여하는 초대예요.`}</p>
          {preview.kind === 'owner' && !preview.accepted && <><label htmlFor="workspace-name">워크스페이스 이름</label><input id="workspace-name" value={workspaceName} required maxLength={80} onChange={(event) => setWorkspaceName(event.target.value)} /></>}
          <button type="submit" className="button primary">{preview.accepted ? '워크스페이스 열기' : '초대 수락'}</button>
        </form>}
      </fieldset></section>
      {beta && <section className="pro-join-card pro-beta-card" aria-labelledby="beta-join-title"><div className="pro-join-icon"><KeyRound aria-hidden="true" /></div><span className="pro-badge">베타 참여 코드</span><h3 id="beta-join-title">내 워크스페이스 만들기</h3><p>서비스 운영자가 발급한 코드로 개설 권한을 활성화해요. 워크스페이스 초대 링크와는 달라요.</p>
        {beta.active ? <><p className="pro-join-status">개설 권한 활성화됨 · 소유 {beta.owned} / {beta.workspaceLimit}개</p><button className="button" disabled={busy || locked || beta.owned >= beta.workspaceLimit} onClick={openCreate}>{beta.owned >= beta.workspaceLimit ? '소유 한도에 도달했어요' : '워크스페이스 만들기'}</button></> : <><p className="pro-join-status">활성화하면 최대 2개 개설 가능</p><a className="button" href={proPath(nav('beta'))} onClick={event => followProLink(event,nav('beta'),onNavigate)}>베타 코드 입력하기</a></>}
      </section>}
      </div></section>}
      {!busy && !detail && !['settings','start','beta'].includes(route.page) && <div className="pro-empty"><h3>{route.orgId ? '워크스페이스에 접근할 수 없어요' : '참여 중인 워크스페이스가 없어요'}</h3><p>{route.orgId ? '현재 계정과 참여 권한을 확인하거나 다른 워크스페이스를 선택해주세요.' : '팀 Owner에게 초대를 요청하거나 Pro Beta를 활성화해 내 워크스페이스를 만들어보세요.'}</p>{route.page !== 'start' && <a className="button" href={proPath({page:'start'})} onClick={event => followProLink(event, {page:'start'}, onNavigate)}>초대 링크로 참여</a>}</div>}
      {organizations.some((org) => !org.active) && <Notice>참여가 중지된 워크스페이스가 있어요. 운영자에게 문의해주세요.</Notice>}
      {route.page === 'settings' && settings}
      {route.page === 'beta' && beta && <ProBeta status={beta} busy={busy || locked} call={call} run={run} onActivated={setBeta} onCreate={openCreate} onSettings={() => onNavigate(nav('settings'))} />}
        {detail && (!route.orgId || detail.id === route.orgId) && <>
          {route.page === 'team' && <section className="pro-page"><header className="pro-page-header"><div><h2>멤버 · 팀</h2><p>{detail.name} · {detail.members.length}명의 멤버</p></div>{detail.role === 'owner' && <button className="button primary" disabled={busy || locked} onClick={() => { if(memberInvite.current) { memberInvite.current.open = true; memberInvite.current.querySelector('input')?.focus() } }}>워크스페이스에 멤버 초대</button>}</header><fieldset className="plain-fieldset pro-panel" disabled={busy || locked}><legend>멤버</legend>
          <ul className="pro-members">{detail.members.map((member) => <li key={member.id}><span>{member.login}{member.id === userId ? ' · 나' : ''}<small>{member.role === 'owner' ? 'Owner' : 'Member'}</small></span><div className="actions">
            {detail.role === 'owner' && <details className="pro-member-menu"><summary>역할 관리</summary><div className="actions"><button type="button" className="button" onClick={() => { setRemoving(null); setChange({question:`${member.login} 계정을 ${member.role === 'owner' ? 'Member' : 'Owner'}로 변경할까요? 파일 권한은 유지돼요.`,path:`/members/${member.id}/role`,body:{role:member.role === 'owner' ? 'member' : 'owner'}}) }}>{member.role === 'owner' ? 'Member로 변경' : 'Owner로 지정'}</button>{member.id !== userId && <button type="button" className="button" onClick={() => { setRemoving(null); setChange({question:`${member.login} 계정으로 Owner를 이전할까요? 내 역할은 Member로 바뀌어요.`,path:'/owner-transfer',body:{userId:member.id}}) }}>Owner 이전</button>}</div></details>}
            {(detail.role === 'owner' || member.id === userId) && <button type="button" className="button" onClick={() => { setChange(null); setRemoving(member) }}>{member.id === userId ? '탈퇴' : '제외'}</button>}
          </div></li>)}</ul>
          {removing && <div className="pro-confirm" role="group" aria-label="멤버 제외 확인"><p>{removing.login} 계정을 이 워크스페이스에서 제외할까요? 이 조직의 파일 접근도 종료돼요.</p><div className="actions"><button type="button" className="button" onClick={() => { void run(async () => { await call(`/organizations/${detail.id}/members/${removing.id}/remove`, {}); setRemoving(null); if(removing.id === userId){setDetail(null);await load('');onNavigate({page:'start'})}else{await load();setMessage('워크스페이스에서 제외했어요.')} }) }}>제외 확인</button><button type="button" className="button" onClick={() => setRemoving(null)}>취소</button></div></div>}
          {change && <div className="pro-confirm" role="group" aria-label="워크스페이스 변경 확인"><p>{change.question}</p><div className="actions"><button type="button" className="button" onClick={() => { void run(async () => { await call('/organizations/'+detail.id+change.path,change.body);setChange(null);if(change.path==='/remove'){setDetail(null);await load('');onNavigate({page:'start'})}else{await load();setMessage('변경 사항을 저장했어요.')} }) }}>변경 확인</button><button type="button" className="button" onClick={() => setChange(null)}>취소</button></div></div>}
          {detail.role === 'owner' && <>
            <details className="pro-panel pro-member-invitation" ref={memberInvite}><summary>워크스페이스에 멤버 초대</summary><p className="help">이 워크스페이스에 참여할 사람을 초대해요. 베타 개설 권한은 부여하지 않아요.</p><form className="pro-form" onSubmit={(event) => { event.preventDefault(); void run(async () => {
              const invite = await call(`/organizations/${detail.id}/invitations`, { login: login.trim(), teamId: inviteTeamId })
              setCreatedLink(invite.url); setLogin(''); await load(); setMessage(`${invite.login} 계정용 초대를 만들었어요. 7일 안에 수락할 수 있어요.`)
            }) }}>
              <label htmlFor="github-invite-login">초대할 GitHub 계정 이름</label><input id="github-invite-login" value={login} required maxLength={39} autoComplete="off" spellCheck={false} onChange={(event) => setLogin(event.target.value)} />
              {detail.teams.length > 1 && <><label htmlFor="invite-team">가입할 팀</label><select id="invite-team" value={inviteTeamId} onChange={(event) => setTeamId(event.target.value)}>{detail.teams.map((team) => <option value={team.id} key={team.id}>{team.name}</option>)}</select></>}
              <button type="submit" className="button">워크스페이스 초대 링크 만들기</button>
            </form>
            {createdLink && <CopyField label="상대에게 전달할 워크스페이스 초대 링크" value={createdLink} />}
            </details>
            {detail.invitations.length > 0 && <><h3>수락 대기 중</h3><ul className="pro-members">{detail.invitations.map((invite) => <li key={invite.id}><span>{invite.login} · {new Date(invite.expiresAt).toLocaleDateString()}까지</span><button type="button" className="button" onClick={() => { void run(async () => { await call(`/organizations/${detail.id}/invitations/${invite.id}/cancel`, {}); setCreatedLink(''); await load(); setMessage('초대를 취소했어요.') }) }}>초대 취소</button></li>)}</ul></>}
            <p>Owner 변경·이전·조직 삭제는 최근 15분 이내 본인 확인이 필요해요.</p><a className="button" href={proPath(nav('settings'))} onClick={event => followProLink(event,nav('settings'),onNavigate)}>설정에서 본인 확인</a>
            <details className="pro-danger"><summary>워크스페이스 삭제</summary><p>이 조직의 멤버 관계와 파일 접근을 종료해요. 계정·기기·다른 워크스페이스는 유지돼요.</p><button className="button" type="button" onClick={() => {setRemoving(null);setChange({question:`${detail.name} 워크스페이스를 삭제할까요? 되돌릴 수 없어요.`,path:'/remove',body:{}})}}>워크스페이스 삭제</button></details>
          </>}
          </fieldset></section>}
          {route.page === 'requests' && <ProRequests key={'requests:' + detail.id + userId + csrf} route={route} onNavigate={onNavigate} api={api} orgId={detail.id} userId={userId} csrf={csrf} disabled={busy || locked} onExpired={onExpired} />}
          {route.page === 'shares' && <ProShares key={'shares:' + detail.id + userId + csrf} route={route} onNavigate={onNavigate} api={api} orgId={detail.id} userId={userId} csrf={csrf} disabled={busy || locked} onExpired={onExpired} />}
          {(route.page === 'projects' || route.page === 'team') && <ProCatalog key={detail.id+':'+route.page} api={api} orgId={detail.id} csrf={csrf} members={detail.members} route={route} onNavigate={onNavigate} disabled={busy || locked} onExpired={onExpired} onTeamsChanged={async () => {
            const updated: Detail = await call('/organizations/' + detail.id)
            setDetail((current) => current?.id === updated.id ? updated : current)
          }} />}
        </>}
      </div>
      <dialog ref={createDialog} className="pro-dialog" aria-labelledby="create-workspace-title" onCancel={event => { if(busy) event.preventDefault() }}>
        <form className="pro-form" onSubmit={event => { event.preventDefault(); void run(async () => {
          const result = await call('/organizations', { name: newName })
          setOrganizations(items => [...items, { ...result, active: 1 }]); setBeta(value => value ? {...value, owned: value.owned + 1} : value)
          createDialog.current?.close(); setMessage('워크스페이스를 만들었어요.')
          onNavigate({page:'projects',orgId:result.id})
        }) }}>
          <h2 id="create-workspace-title">새 워크스페이스 만들기</h2><p>함께 일할 팀의 이름을 입력해주세요. 소유 {beta?.owned ?? 0} / {beta?.workspaceLimit ?? 2}개</p>
          <label htmlFor="new-workspace-name">워크스페이스 이름</label><input id="new-workspace-name" value={newName} onChange={event => setNewName(event.target.value)} required maxLength={80} autoFocus disabled={busy || locked} />
          {error && <Notice error>{error}</Notice>}
          <div className="actions"><button type="button" className="button" disabled={busy} onClick={() => createDialog.current?.close()}>취소</button><button type="submit" className="button primary" disabled={busy || locked || !newName.trim() || !beta?.active || beta.owned >= beta.workspaceLimit}>{busy ? '만드는 중…' : '워크스페이스 만들기'}</button></div>
        </form>
      </dialog>
    </div>
  )
}

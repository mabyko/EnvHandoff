import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowRight, Info, LogOut, Settings, ShieldCheck } from 'lucide-react'
import { Notice } from './ui.tsx'
import { ProOrganizations } from './ProOrganizations.tsx'
import { ProSecurity } from './ProSecurity.tsx'
import { followProLink, pendingProRoute, proPath, proReturnKey, readProRoute } from '../lib/pro-navigation.ts'
import type { ProRoute } from '../lib/pro-navigation.ts'
import { confirmWorkLoss } from '../lib/external-share.ts'
import { pendingInvitation } from '../lib/invitation.ts'

const api = import.meta.env.VITE_PRO_API_ORIGIN ?? (import.meta.env.DEV ? 'http://localhost:3001' : 'https://api.envhandoff.mabyko.com')
type Session = { user: { id: string; login: string }; csrf: string; expiresAt: number; acceptNewTransfers?: boolean }

export function ProLogin() {
  const [route, setRoute] = useState(pendingProRoute)
  const [initialToken, setInitialToken] = useState(pendingInvitation)
  const [session, setSession] = useState<Session | null>()
  const [busy, setBusy] = useState(true)
  const [authAction, setAuthAction] = useState<'start' | 'logout' | null>(null)
  const [sessionUnavailable, setSessionUnavailable] = useState(false)
  const [error, setError] = useState(() => new URLSearchParams(location.search).has('auth') ? 'GitHub 로그인을 완료하지 못했어요. 다시 시도해주세요.' : '')
  const channel = useRef<BroadcastChannel | null>(null)
  const generation = useRef(0)
  const authentication = useRef<AbortController | null>(null)
  const lifetime = useRef<AbortController | null>(null)
  const currentRoute = useRef(route)
  const historyIndex = useRef(0)
  const restoring = useRef(false)
  const refreshSession = useRef<() => void>(() => {})
  useLayoutEffect(() => { currentRoute.current = route }, [route])

  const canNavigate = (next: ProRoute | null) => {
    const previous = currentRoute.current
    if (previous && next && proPath(previous) === proPath(next)) return true
    if (previous?.page === 'shares' && next?.page === 'shares' && previous.orgId === next.orgId) return true
    return confirmWorkLoss()
  }
  function navigate(next: ProRoute) {
    const path = proPath(next)
    if (restoring.current || !canNavigate(next)) return
    if (currentRoute.current && proPath(currentRoute.current) === path) return
    history.pushState({ envhandoffProIndex: ++historyIndex.current }, '', path)
    setRoute(next)
  }
  function resolveOrganization(orgId: string) {
    const previous = currentRoute.current
    if (!previous || previous.orgId) return
    const next = { ...previous, orgId }
    history.replaceState({ ...history.state, envhandoffProIndex: historyIndex.current }, '', proPath(next))
    setRoute(next)
  }
  function expired() { generation.current++; authentication.current?.abort(); authentication.current = null; setSession(null); setBusy(false); setAuthAction(null); channel.current?.postMessage('signed-out') }

  useEffect(() => {
    historyIndex.current = Number.isSafeInteger(history.state?.envhandoffProIndex) ? history.state.envhandoffProIndex : 0
    history.replaceState({ ...history.state, envhandoffProIndex: historyIndex.current }, '', currentRoute.current ? proPath(currentRoute.current) : location.pathname + location.search)
    const onPop = () => {
      if (restoring.current) { restoring.current = false; return }
      const next = readProRoute(location.pathname, location.search)
      const nextIndex = history.state?.envhandoffProIndex
      if (!canNavigate(next)) {
        if (Number.isSafeInteger(nextIndex) && nextIndex !== historyIndex.current) {
          restoring.current = true
          history.go(historyIndex.current - nextIndex)
        } else history.pushState({ envhandoffProIndex: historyIndex.current }, '', currentRoute.current ? proPath(currentRoute.current) : '/pro')
        return
      }
      historyIndex.current = Number.isSafeInteger(nextIndex) ? nextIndex : 0
      setRoute(next)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('.pro-content')?.focus({ preventScroll: true })
      window.scrollTo({ top: 0 })
    })
    return () => cancelAnimationFrame(frame)
  }, [route])

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    const refresh = async () => {
      if (authentication.current) return
      const current = ++generation.current
      setBusy(true)
      try {
        const response = await fetch(api + '/auth/session', { credentials: 'include', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
        if (!response.ok && response.status !== 401) throw new Error('Session request failed')
        const value = response.ok ? await response.json() as Session : null
        if (!controller.signal.aborted && current === generation.current) {
          setSession(value); setSessionUnavailable(false)
          if (value) { try { sessionStorage.removeItem(proReturnKey) } catch { /* Navigation works without storage. */ } }
        }
      } catch {
        if (!controller.signal.aborted && current === generation.current) setSessionUnavailable(true)
      } finally { if (!controller.signal.aborted && current === generation.current) setBusy(false) }
    }
    const broadcast = new BroadcastChannel('envhandoff-auth')
    refreshSession.current = () => { void refresh() }
    channel.current = broadcast
    broadcast.onmessage = event => { if (event.data === 'signed-out') setSession(null); void refresh() }
    broadcast.postMessage('changed')
    void refresh()
    const openInvitation = () => { if (location.hash.startsWith('#invite=')) location.reload() }
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      authentication.current?.abort(); authentication.current = null; setAuthAction(null)
      void refresh()
    }
    window.addEventListener('hashchange', openInvitation)
    window.addEventListener('focus', refresh)
    window.addEventListener('pageshow', restore)
    return () => { controller.abort(); broadcast.close(); channel.current = null; window.removeEventListener('focus', refresh); window.removeEventListener('hashchange', openInvitation); window.removeEventListener('pageshow', restore) }
  }, [])

  useEffect(() => {
    if (!session) return
    const expiry = setTimeout(() => { expired() }, Math.max(0, session.expiresAt - Date.now()))
    return () => clearTimeout(expiry)
  }, [session])

  async function act(action: 'start' | 'logout') {
    if (busy || authentication.current) return
    if (action === 'logout' && !confirmWorkLoss()) return
    const controller = new AbortController()
    authentication.current = controller
    const current = ++generation.current
    const signal = AbortSignal.any([controller.signal, lifetime.current!.signal, AbortSignal.timeout(15_000)])
    let redirecting = false
    setBusy(true); setAuthAction(action); setError('')
    try {
      const response = await fetch(api + (action === 'start' ? '/auth/github/start' : '/auth/logout'), {
        method: 'POST', credentials: 'include', headers: session ? { 'x-csrf-token': session.csrf } : {}, signal,
      })
      signal.throwIfAborted()
      if (response.status === 401) { setSession(null); channel.current?.postMessage('signed-out'); throw new Error('Expired session') }
      if (!response.ok) throw new Error('Authentication request failed')
      if (action === 'start') {
        const { url } = await response.json() as { url: string }
        signal.throwIfAborted()
        const destination = new URL(url)
        if (destination.origin !== 'https://github.com' || destination.pathname !== '/login/oauth/authorize') throw new Error('Invalid login URL')
        if (current === generation.current) {
          try { if (route) sessionStorage.setItem(proReturnKey, proPath(route)); else sessionStorage.removeItem(proReturnKey) } catch { /* The user can reopen the detail link after login. */ }
          location.assign(destination.href)
          redirecting = true
        }
      } else {
        setSession(null); channel.current?.postMessage('signed-out')
      }
    } catch {
      if (!controller.signal.aborted && !lifetime.current?.signal.aborted && current === generation.current) setError(action === 'start' ? '로그인을 시작하지 못했어요. 잠시 후 다시 시도해주세요.' : '로그아웃을 확인하지 못했어요. 새로고침 후 다시 시도해주세요.')
    } finally {
      if (!redirecting && authentication.current === controller) authentication.current = null
      if (!redirecting && !controller.signal.aborted && !lifetime.current?.signal.aborted && current === generation.current) { setBusy(false); setAuthAction(null) }
    }
  }
  const settingsRoute: ProRoute = { page: 'settings', ...(route?.orgId ? { orgId: route.orgId } : {}) }
  return (
    <section className="pro-app" aria-busy={busy}>
      <div className="pro-topbar">
        <div><p className="pro-eyebrow">TEAM WORKSPACE</p><h1>EnvHandoff <span>Pro</span> <small className="pro-badge">BETA</small></h1>
          <div className="pro-header-status">
            {session?.acceptNewTransfers === false && <details className="pro-service-status"
              onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false }}
              onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
              <summary><Info aria-hidden="true" />전달 일시 중지</summary>
              <p>새로운 파일 전달이 일시 중지돼 있어요. 기존 전달은 원래 기한까지 받을 수 있어요.</p>
            </details>}
            <span className="pro-session-status" role="status">{busy ? authAction === 'start' ? 'GitHub로 이동 중…' : authAction === 'logout' ? '로그아웃 중…' : '로그인 확인 중…' : ''}</span>
          </div>
        </div>
        {session && <div className="pro-account"><span className="pro-account-name">{session.user.login}</span><a className="text-button" href={proPath(settingsRoute)} aria-current={route?.page === 'settings' ? 'page' : undefined} onClick={event => followProLink(event, settingsRoute, navigate)}><Settings aria-hidden="true" />내 설정</a><button type="button" className="text-button" disabled={busy} onClick={() => { void act('logout') }}><LogOut aria-hidden="true" />로그아웃</button></div>}
      </div>
      {error && <Notice error>{error}</Notice>}
      {sessionUnavailable && <Notice error>서버에 연결하지 못해 작업을 잠시 멈췄어요. 이 탭의 파일과 코드는 유지돼요. <button className="button" type="button" disabled={busy} onClick={() => refreshSession.current()}>연결 다시 확인</button></Notice>}
      {!route ? <div className="pro-entry"><div className="pro-entry-intro"><h2>페이지를 찾을 수 없어요</h2><p className="lead">링크 주소를 확인하거나 Pro 시작 화면으로 돌아가세요.</p></div><a className="button" href="/pro" onClick={event => followProLink(event, { page: 'start' }, navigate)}>Pro 시작으로</a></div> : session ? (
        <ProOrganizations key={'organizations:' + session.user.id + ':' + session.csrf} route={route} onNavigate={navigate} onResolvedOrganization={resolveOrganization} api={api} userId={session.user.id} csrf={session.csrf} initialToken={initialToken} disabled={busy || sessionUnavailable} onAccepted={() => setInitialToken('')} onExpired={expired}
          settings={<ProSecurity key={'security:' + session.user.id + ':' + session.csrf} api={api} userId={session.user.id} csrf={session.csrf} disabled={busy || sessionUnavailable} onExpired={expired} onDeleted={warning => { setError(warning); expired() }} />} />
      ) : (session !== undefined || sessionUnavailable) && (
        <div className="pro-entry pro-entry-grid">
          <div>
            <p className="pro-entry-kicker"><ShieldCheck aria-hidden="true" />팀을 위한 설정 파일 공유</p>
            <div className="pro-entry-intro">
              <h2>팀의 설정,<br />필요할 때 요청하세요.</h2>
              <p className="lead">매번 누구에게 물어볼지 찾지 않아도 돼요. 팀의 프로젝트에서 필요한 설정을 요청하고 받아보세요.</p>
            </div>
            <button type="button" className="button primary" disabled={busy} onClick={() => { void act('start') }}>
              {authAction === 'start' ? 'GitHub로 이동 중…' : 'GitHub로 로그인'}<ArrowRight aria-hidden="true" />
            </button>
            <p className="help pro-entry-footer">무료 초대 베타예요. 팀의 초대 링크로 참여하거나, 베타 코드로 내 워크스페이스를 만들 수 있어요.</p>
          </div>
          <ol className="pro-entry-steps" aria-label="팀에서 시작하는 방법">
            <li><span aria-hidden="true">01</span><div><strong>팀에 참여하기</strong><p>GitHub로 로그인하고 받은 초대를 수락해요.</p></div></li>
            <li><span aria-hidden="true">02</span><div><strong>필요한 설정 요청하기</strong><p>프로젝트와 환경을 골라 팀원에게 요청해요.</p></div></li>
            <li><span aria-hidden="true">03</span><div><strong>받아서 프로젝트에 넣기</strong><p>승인된 브라우저에서 열고 원본을 다운로드해요.</p></div></li>
          </ol>
        </div>
      )}

    </section>
  )
}

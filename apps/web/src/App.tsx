import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowRightLeft,
  ArrowUpRight,
  Home,
  Moon,
  Sun,
} from 'lucide-react'
import { version } from '../package.json'
import { LandingHome } from './components/LandingHome.tsx'
import { SendFlow } from './components/SendFlow.tsx'
import { ReceiveFlow } from './components/ReceiveFlow.tsx'
import { ProLogin } from './components/ProLogin.tsx'
import { ExternalReceive } from './components/ExternalReceive.tsx'
import { confirmWorkLoss, readExternalShare } from './lib/external-share.ts'
import { readInvitation } from './lib/relay.ts'
import type { Invitation } from '@envhandoff/protocol'

type Route = { view: 'external'; id?: string; token?: string } | { view: 'home' | 'send' | 'pro' } | { view: 'receive'; invitation?: Invitation; invalid?: boolean }

function readRoute(): Route {
  if (location.pathname.startsWith('/receive/')) return { view: 'external', ...readExternalShare(location.pathname, location.hash) }
  if (location.pathname === '/pro' || location.pathname.startsWith('/pro/')) return { view: 'pro' }
  if (location.hash.startsWith('#receive')) {
    const invitation = readInvitation(location.hash)
    return { view: 'receive', invitation: invitation ?? undefined, invalid: !invitation }
  }
  if (location.pathname === '/send') return { view: 'send' }
  if (location.pathname === '/receive') return { view: 'receive' }
  return { view: 'home' }
}

export default function App() {
  const [route, setRoute] = useState<Route>(readRoute)
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const [arrival, setArrival] = useState(0)
  const currentRoute = useRef(route), currentURL = useRef(location.pathname + location.search)
  const historyIndex = useRef(Number.isSafeInteger(history.state?.envhandoffFreeIndex) ? history.state.envhandoffFreeIndex : 0)
  const restoring = useRef(false)
  useLayoutEffect(() => { currentRoute.current = route }, [route])
  useLayoutEffect(() => {
    const state = () => ({ ...history.state, envhandoffFreeIndex: historyIndex.current })
    const clearFragment = () => history.replaceState(currentRoute.current.view === 'pro' ? history.state : state(), '', `${location.pathname}${location.search}`)
    const receiveLink = () => {
      let next: Route
      if (location.pathname.startsWith('/receive/') && location.hash.startsWith('#token=')) {
        next = { view: 'external', ...readExternalShare(location.pathname, location.hash) }
      } else {
        if (location.pathname !== '/' || !location.hash.startsWith('#receive')) return
        const invitation = readInvitation(location.hash)
        next = { view: 'receive', invitation: invitation ?? undefined, invalid: !invitation }
      }
      clearFragment()
      if (!confirmWorkLoss()) { history.replaceState(state(), '', currentURL.current); return }
      historyIndex.current++
      currentURL.current = location.pathname + location.search
      history.replaceState(state(), '', currentURL.current)
      setRoute(next); setArrival(value => value + 1)
    }
    const acceptLocation = () => {
      historyIndex.current = Number.isSafeInteger(history.state?.envhandoffFreeIndex) ? history.state.envhandoffFreeIndex : 0
      currentURL.current = location.pathname + location.search
      setRoute(readRoute()); setArrival(value => value + 1)
      window.scrollTo({ top: 0 })
    }
    const onPop = () => {
      if (currentRoute.current.view === 'pro') return
      if (restoring.current) { restoring.current = false; return }
      if (location.hash.startsWith('#receive') || location.pathname.startsWith('/receive/') && location.hash.startsWith('#token=')) return
      const nextIndex = history.state?.envhandoffFreeIndex
      if (location.pathname + location.search === currentURL.current) {
        historyIndex.current = Number.isSafeInteger(nextIndex) ? nextIndex : historyIndex.current + 1
        history.replaceState(state(), '', location.href)
        return
      }
      if (!confirmWorkLoss()) {
        if (Number.isSafeInteger(nextIndex) && nextIndex !== historyIndex.current) {
          restoring.current = true
          history.go(historyIndex.current - nextIndex)
        } else history.pushState(state(), '', currentURL.current)
        return
      }
      acceptLocation()
    }
    if (location.hash) clearFragment()
    else if (currentRoute.current.view !== 'pro') history.replaceState(state(), '', currentURL.current)
    window.addEventListener('hashchange', receiveLink)
    window.addEventListener('popstate', onPop)
    window.addEventListener('envhandoff:free-navigation', acceptLocation)
    return () => {
      window.removeEventListener('hashchange', receiveLink)
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('envhandoff:free-navigation', acceptLocation)
    }
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [dark])
  const navigate = (view: 'home' | 'send' | 'receive') => {
    if (currentRoute.current.view === view) return
    if (restoring.current || !confirmWorkLoss()) return
    const path = view === 'home' ? '/' : '/' + view
    history.pushState({ ...history.state, envhandoffFreeIndex: ++historyIndex.current }, '', path)
    currentURL.current = path
    setRoute({ view })
    window.scrollTo({ top: 0 })
  }
  const home = () => {
    if (route.view === 'pro') { if (confirmWorkLoss()) location.assign('/') }
    else navigate('home')
  }

  return (
    <div className={`page-wrap${route.view === 'pro' ? ' pro-page' : ''}`}>
      <a className="pro-skip-link" href="#main-content">본문으로 건너뛰기</a>
      <div className="app-window">
        <header className="appbar">
          <button type="button" className="brand" onClick={home} aria-label="EnvHandoff 소개 홈">
            <span className="brand-mark">
              <ArrowRightLeft aria-hidden="true" />
            </span>
            EnvHandoff
          </button>
          <div className="header-actions">
            {route.view === 'home' ? (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  const heading = document.getElementById('how-it-works')
                  heading?.focus({ preventScroll: true })
                  heading?.scrollIntoView({ block: 'start' })
                }}
              >
                사용 방법
              </button>
            ) : (
              <button type="button" className="text-button" onClick={home}>
                <Home aria-hidden="true" />
                <span>홈으로</span>
              </button>
            )}
            {route.view === 'home' && <a className="text-button" href="/pro">Pro</a>}
            <button
              type="button"
              className="icon-button"
              onClick={() => setDark(!dark)}
              aria-label={dark ? '밝은 화면으로 전환' : '어두운 화면으로 전환'}
            >
              {dark ? <Sun /> : <Moon />}
            </button>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className={route.view === 'home' ? 'landing-main' : route.view === 'pro' ? 'pro-main' : 'work-area'}>
          {route.view === 'home' ? (
            <LandingHome onSend={() => navigate('send')} onReceive={() => navigate('receive')} />
          ) : (
            <div className={route.view === 'pro' ? 'pro-frame' : 'work-card'}>
              {route.view === 'pro' && <ProLogin />}
              {route.view === 'external' && <ExternalReceive key={arrival} id={route.id} token={route.token} onHome={home} />}
              {route.view === 'send' && <SendFlow onHome={home} />}
              {route.view === 'receive' && (
                <ReceiveFlow key={arrival} invitation={route.invitation} invalid={route.invalid} onHome={home} />
              )}
            </div>
          )}
        </main>
        <footer className="app-footer">
          <span>아는 사람끼리, 필요한 파일만.</span>
          <div className="footer-links">
            {route.view === 'home' && <a className="text-button" href="/pro">Pro</a>}
            <span>v{version}</span>
            <a
              className="text-button repository-link"
              href="https://github.com/mabyko/EnvHandoff"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub 저장소 (새 탭)"
            >
              GitHub
              <ArrowUpRight aria-hidden="true" />
            </a>
          </div>
        </footer>
      </div>
      {route.view !== 'home' && route.view !== 'pro' && (
        <p className="page-note">새로고침하거나 탭을 닫으면 진행 중인 작업이 지워져요.</p>
      )}
    </div>
  )
}

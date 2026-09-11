import { useEffect, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowRightLeft,
  ArrowUpFromLine,
  Home,
  LockKeyhole,
  Moon,
  Sun,
} from 'lucide-react'
import { version } from '../package.json'
import { SendFlow } from './components/SendFlow.tsx'
import { ReceiveFlow } from './components/ReceiveFlow.tsx'
import { readInvitation } from './lib/relay.ts'
import type { Invitation } from '@envhandoff/protocol'

type Route = { view: 'home' | 'send' } | { view: 'receive'; invitation?: Invitation; invalid?: boolean }

export default function App() {
  const [route, setRoute] = useState<Route>(() => {
    if (!location.hash.startsWith('#receive')) return { view: 'home' }
    const invitation = readInvitation(location.hash)
    return { view: 'receive', invitation: invitation ?? undefined, invalid: !invitation }
  })
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const [arrival, setArrival] = useState(0)
  useEffect(() => {
    const clearFragment = () => history.replaceState(null, '', `${location.pathname}${location.search}`)
    const receiveLink = () => {
      if (!location.hash.startsWith('#receive')) return
      const invitation = readInvitation(location.hash)
      clearFragment()
      setRoute({ view: 'receive', invitation: invitation ?? undefined, invalid: !invitation })
      setArrival((value) => value + 1)
    }
    if (location.hash) clearFragment()
    window.addEventListener('hashchange', receiveLink)
    return () => window.removeEventListener('hashchange', receiveLink)
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [dark])
  const home = () => {
    setRoute({ view: 'home' })
    window.scrollTo({ top: 0 })
  }

  return (
    <div className="page-wrap">
      <div className="app-window">
        <header className="appbar">
          <div className="brand">
            <span className="brand-mark">
              <ArrowRightLeft aria-hidden="true" />
            </span>
            EnvHandoff
          </div>
          <div className="header-actions">
            {route.view !== 'home' && (
              <button type="button" className="text-button" onClick={home}>
                <Home aria-hidden="true" />
                <span>시작 화면</span>
              </button>
            )}
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
        <main className="app-inner">
          {route.view === 'home' && (
            <div className="start">
              <div className="intro-mark">
                <ArrowRightLeft aria-hidden="true" />
              </div>
              <h1>설정 파일, 안전하게 건네기</h1>
              <p className="lead">
                Git에 없는 개발 설정을
                <br className="mobile-break" /> 함께 일하는 사람에게 전달하세요.
              </p>
              <div className="choices">
                <button className="choice" type="button" onClick={() => setRoute({ view: 'send' })}>
                  <span className="choice-icon">
                    <ArrowUpFromLine aria-hidden="true" />
                  </span>
                  <strong>파일 보내기</strong>
                  <ArrowRight aria-hidden="true" />
                  <span className="choice-description">
                    필요한 파일만 골라
                    <br /> 암호화해서 전달해요.
                  </span>
                </button>
                <button className="choice" type="button" onClick={() => setRoute({ view: 'receive' })}>
                  <span className="choice-icon">
                    <ArrowDownToLine aria-hidden="true" />
                  </span>
                  <strong>파일 가져오기</strong>
                  <ArrowRight aria-hidden="true" />
                  <span className="choice-description">
                    공유 파일과 코드로 열고
                    <br /> 원본 파일을 다운로드해요.
                  </span>
                </button>
              </div>
              <p className="start-note">
                <LockKeyhole aria-hidden="true" />
                파일은 이 브라우저에서 암호화돼요.
              </p>
            </div>
          )}
          {route.view === 'send' && <SendFlow onHome={home} />}
          {route.view === 'receive' && (
            <ReceiveFlow key={arrival} invitation={route.invitation} invalid={route.invalid} onHome={home} />
          )}
        </main>
        <footer className="app-footer">
          <span>아는 사람끼리, 필요한 파일만.</span>
          <span>v{version}</span>
        </footer>
      </div>
      <p className="page-note">새로고침하거나 탭을 닫으면 진행 중인 작업이 지워져요.</p>
    </div>
  )
}

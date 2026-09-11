import { useEffect, useRef, useState } from 'react'
import { Check, Link, LoaderCircle, Radio } from 'lucide-react'
import type { RelaySession } from '@envhandoff/protocol'
import type { SealedBundle } from '../lib/bundle.ts'
import { connectRelay, createRelaySession, invitationUrl } from '../lib/relay.ts'
import type { RelayConnection } from '../lib/relay.ts'
import { CopyField, Heading, Notice, Progress } from './ui.tsx'
import { initialLiveState, updateLive } from '../lib/relay-state.ts'
import type { LiveState } from '../lib/relay-state.ts'

export function LiveStatus({ state, receiving = false }: { state: LiveState; receiving?: boolean }) {
  const titles = {
    connecting: '연결을 준비하고 있어요',
    waiting: receiving ? '보낸 사람의 연결을 기다리고 있어요' : '받는 사람을 기다리고 있어요',
    peer: receiving ? '보낸 사람의 승인을 기다리고 있어요' : '받는 사람이 연결됐어요',
    sending: '암호화 파일을 전달하고 있어요',
    transferred: receiving ? '공유 코드로 파일을 열어주세요' : '수신 확인을 기다리고 있어요',
    complete: receiving ? '파일 수신을 알렸어요' : '상대가 파일을 열었어요',
    error: '전달이 중단됐어요',
  }
  return (
    <div className={`live-status ${state.status === 'complete' ? 'success' : ''}`}>
      <div className="status-title" role="status">
        {state.status === 'complete' ? <Check aria-hidden="true" /> : <Radio aria-hidden="true" />}
        <h2>{titles[state.status]}</h2>
      </div>
      {state.status === 'peer' && (
        <>
          <p>대화 중인 상대와 두 화면의 확인 숫자가 같은지 확인해주세요.</p>
          <p className="verification" aria-label={`연결 확인 숫자 ${state.verification}`}>
            {state.verification.slice(0, 3)} {state.verification.slice(3)}
          </p>
          <p className="help">이 숫자는 연결을 비교하는 용도예요. 신원 인증이나 공유 코드가 아니에요.</p>
        </>
      )}
      {state.status === 'waiting' && (
        <p>
          {receiving
            ? '보낸 사람이 이 화면을 열어두고 있는지 확인해주세요.'
            : '아래 연결 링크를 대화 중인 상대에게 보내주세요.'}
        </p>
      )}
      {(state.status === 'sending' || state.status === 'transferred') && <Progress percent={state.percent} />}
      {state.status === 'transferred' && (
        <p>
          {receiving
            ? '2분 안에 파일을 열면 보낸 사람에게 수신 완료를 알려요.'
            : '상대가 코드로 파일을 열면 완료돼요. 최대 2분 동안 기다려요.'}
        </p>
      )}
      {state.status === 'complete' && (
        <p>
          {receiving
            ? '아래에서 필요한 원본 파일을 다운로드하세요.'
            : '전체 공유 파일을 열었다는 응답을 받았어요. 프로젝트 적용 여부는 별도로 확인해주세요.'}
        </p>
      )}
      {state.status === 'error' && <Notice error>{state.error}</Notice>}
    </div>
  )
}

function Expiration({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  return (
    <p className="help">
      연결 유효 시간 {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')} · 받는 사람 1명 · 두
      화면을 열어두세요.
    </p>
  )
}

export function LiveSender({
  sealed,
  onFallback,
  onHome,
}: {
  sealed: SealedBundle
  onFallback: () => void
  onHome: () => void
}) {
  const [session, setSession] = useState<RelaySession | null>(null)
  const [state, setState] = useState(initialLiveState)
  const [attempt, setAttempt] = useState(0)
  const connection = useRef<RelayConnection | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    request.current = controller
    void createRelaySession(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setSession(result)
        connection.current = connectRelay({ id: result.id, token: result.senderToken }, 'sender', (event) => {
          if (!controller.signal.aborted) setState((current) => updateLive(current, event))
        })
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setState((current) =>
            updateLive(current, {
              type: 'error',
              reason: reason instanceof Error ? reason.message : 'UNAVAILABLE',
            }),
          )
      })
    return () => {
      controller.abort()
      connection.current?.close()
      connection.current = null
    }
  }, [attempt])
  const approve = () => {
    setState((current) => ({ ...current, status: 'sending' }))
    connection.current?.approve(state.peerId, sealed.bytes)
  }

  return (
    <>
      <Heading
        title={state.status === 'complete' ? '실시간 전달을 마쳤어요' : '연결하고, 확인하고, 전달해요'}
      >
        {sealed.projectLabel} · {sealed.environment} · {sealed.fileCount}개 파일
      </Heading>
      <LiveStatus state={state} />
      {state.status === 'peer' && (
        <button className="button primary wide" type="button" onClick={approve}>
          <Check aria-hidden="true" />
          상대를 확인했어요 · 전달하기
        </button>
      )}
      {session && state.status !== 'error' && state.status !== 'complete' && (
        <div className="live-share" key={session.id}>
          <div className="section-title">
            <Link aria-hidden="true" />
            <h2>연결 링크 보내기</h2>
          </div>
          <CopyField value={invitationUrl(session)} label="일회성 연결 링크" />
          <Expiration expiresAt={session.expiresAt} />
          <CopyField value={sealed.code} label="다른 대화 경로로 보낼 공유 코드" secret />
          <Notice>연결 링크만으로는 파일을 열 수 없어요. 공유 코드는 따로 보내주세요.</Notice>
        </div>
      )}
      {state.status === 'connecting' && (
        <p className="connecting">
          <LoaderCircle className="spinner" aria-hidden="true" />
          연결 링크를 만들고 있어요.
        </p>
      )}
      <div className="actions">
        {state.status === 'complete' ? (
          <button type="button" className="button primary" onClick={onHome}>
            작업 마치기
          </button>
        ) : (
          <>
            <button type="button" className="button" onClick={onFallback}>
              공유 파일로 전달하기
            </button>
            {state.status === 'error' ? (
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  setSession(null)
                  setState(initialLiveState)
                  setAttempt((value) => value + 1)
                }}
              >
                새 연결 만들기
              </button>
            ) : (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  request.current?.abort()
                  connection.current?.close()
                  setState((current) => ({
                    ...current,
                    status: 'error',
                    error: '전달을 취소했어요. 새 연결을 만들거나 공유 파일로 전달할 수 있어요.',
                  }))
                }}
              >
                전달 취소
              </button>
            )}
          </>
        )}
      </div>
    </>
  )
}

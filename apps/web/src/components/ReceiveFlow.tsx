import { useEffect, useRef, useState } from 'react'
import { Check, Download, File, FileUp, LockKeyhole } from 'lucide-react'
import type { Invitation } from '@envhandoff/protocol'
import { explainError, LIMITS, openBundle } from '../lib/bundle.ts'
import type { OpenedBundle } from '../lib/bundle.ts'
import { downloadFile, formatSize, previewText } from '../lib/files.ts'
import { connectRelay } from '../lib/relay.ts'
import type { RelayConnection } from '../lib/relay.ts'
import { CodeInput, CopyField, Heading, Notice, Steps } from './ui.tsx'
import { LiveStatus } from './live.tsx'
import { initialLiveState, updateLive } from '../lib/relay-state.ts'
import { useWorkLoss } from '../lib/work-loss.ts'

export function ReceiveFlow({
  invitation,
  invalid,
  onHome,
}: {
  invitation?: Invitation
  invalid?: boolean
  onHome: () => void
}) {
  const [live, setLive] = useState(Boolean(invitation))
  const [state, setState] = useState(initialLiveState)
  const [incoming, setIncoming] = useState<ArrayBuffer | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [code, setCode] = useState('')
  const [opened, setOpened] = useState<OpenedBundle | null>(null)
  const [error, setError] = useState(
    invalid ? '연결 링크가 올바르지 않아요. 새 링크를 받거나 공유 파일을 선택해주세요.' : '',
  )
  const [busy, setBusy] = useState(false)
  const hasWork = !!file || !!incoming || !!code || !!opened || busy || (live && !!invitation)
  useWorkLoss(hasWork)
  const epoch = useRef(0)
  const connection = useRef<RelayConnection | null>(null)
  useEffect(
    () => () => {
      epoch.current++
    },
    [],
  )
  useEffect(() => {
    if (!invitation || !live) return
    let active = true
    connection.current = connectRelay(
      invitation,
      'receiver',
      (event) => {
        if (!active) return
        if (event.type === 'error') {
          epoch.current++
          setBusy(false)
          setIncoming(null)
        }
        setState((current) => updateLive(current, event))
      },
      (bytes) => {
        if (active) setIncoming(bytes)
      },
    )
    return () => {
      active = false
      connection.current?.close()
      connection.current = null
    }
  }, [invitation, live])
  const unlock = async () => {
    const operation = ++epoch.current
    setBusy(true)
    setError('')
    try {
      if (file && file.size > LIMITS.bundleBytes) {
        setError('공유 파일은 최대 16 MiB까지 열 수 있어요.')
        return
      }
      const buffer = live ? incoming : await file?.arrayBuffer()
      if (!buffer) {
        setError('먼저 공유 파일을 선택하거나 수신해주세요.')
        return
      }
      const result = await openBundle(buffer, code)
      if (operation !== epoch.current) return
      setOpened(result)
      setCode('')
      setFile(null)
      setIncoming(null)
      if (live) connection.current?.receipt()
    } catch (reason) {
      if (operation === epoch.current) setError(explainError(reason))
    } finally {
      if (operation === epoch.current) setBusy(false)
    }
  }
  const fallback = () => {
    epoch.current++
    setBusy(false)
    setLive(false)
    setIncoming(null)
    setError('')
  }

  return (
    <>
      <span hidden data-work-loss={hasWork} />
      <Steps labels={['공유 파일 열기', '파일 다운로드']} current={opened ? 1 : 0} />
      {opened ? (
        <>
          <Heading title="이제 프로젝트에 넣어주세요">파일을 내려받고, 표시된 경로에 직접 넣으세요.</Heading>
          <div className="flow-layout">
          <div className="flow-main flow-result">
          {live && <LiveStatus state={state} receiving />}
          <OpenedFiles bundle={opened} />
          <div className="actions end flow-toolbar">
            <button type="button" className="button" onClick={onHome}>
              작업 마치기
            </button>
          </div>
          </div>
          <aside className="flow-aside" aria-label="파일 배치 안내">
            <div className="flow-section-header"><h2>다운로드 다음에는</h2></div>
            <p className="help">표시된 경로는 Git 저장소 루트 기준이에요. <code>apps/api/.env</code>라면 저장소의 <code>apps/api</code> 폴더에 넣으세요.</p>
            <p className="help">기존 파일이 있으면 덮어쓰기 전에 내용을 확인하세요.</p>
          </aside>
          </div>
        </>
      ) : (
        <>
          <Heading title={live ? '공유 파일을 받고 있어요' : '공유 파일 열기'}>
            {live
              ? '보낸 사람과 연결을 확인하고, 별도로 받은 코드를 입력해주세요.'
              : '받은 .envhandoff 파일을 선택하고 공유 코드를 입력하세요.'}
          </Heading>
          <div className="flow-layout">
          <div className="flow-main">
          {live && <section className="flow-section"><LiveStatus state={state} receiving /></section>}
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void unlock()
            }}
          >
            <fieldset disabled={busy} className="plain-fieldset">
              {!live && (
                <section className="flow-section" aria-labelledby="receive-file-heading">
                  <div className="flow-section-header"><h2 id="receive-file-heading">공유 파일</h2></div>
                <label className={`file-picker ${file ? 'chosen' : ''}`}>
                  <FileUp aria-hidden="true" />
                  <strong>{file ? file.name : '공유 파일 선택'}</strong>
                  <span>
                    {file
                      ? `${formatSize(file.size)} · 다른 파일로 바꾸려면 선택`
                      : '.envhandoff 파일 · 최대 16 MiB'}
                  </span>
                  <input
                    type="file"
                    accept=".envhandoff"
                    aria-label="공유 파일 선택"
                    onChange={(event) => {
                      const chosen = event.target.files?.[0]
                      if (chosen) {
                        epoch.current++
                        setFile(chosen)
                        setError('')
                      }
                      event.target.value = ''
                    }}
                  />
                </label>
                </section>
              )}
              <section className="flow-section" aria-label="공유 코드 입력">
              <CodeInput
                value={code}
                onChange={(value) => {
                  setCode(value)
                  setError('')
                }}
              />
              </section>
              {error && <Notice error>{error}</Notice>}
              <div className="actions flow-toolbar">
                {live ? (
                  <button type="button" className="text-button" onClick={fallback}>
                    공유 파일로 가져오기
                  </button>
                ) : (
                  <span className="muted">
                    <LockKeyhole className="inline-icon" aria-hidden="true" />이 브라우저에서만 열어요.
                  </span>
                )}
                <button
                  className="button primary"
                  type="submit"
                  disabled={busy || !code.trim() || (live ? !incoming || state.status === 'error' : !file)}
                >
                  <LockKeyhole aria-hidden="true" />
                  {busy ? '파일 여는 중…' : '파일 열기'}
                </button>
              </div>
            </fieldset>
          </form>
          </div>
          <aside className="flow-aside" aria-label="공유 파일 안내">
            <div className="flow-section-header"><h2>준비할 것</h2></div>
            <p className="help">보낸 사람에게 받은 공유 파일과 공유 코드가 필요해요. 코드는 파일을 받은 곳과 다른 경로로 확인하세요.</p>
            <details className="flow-options"><summary>코드를 잃었다면</summary><p className="help">공유 코드는 복구할 수 없어요. 보낸 사람에게 새 공유 파일과 코드를 요청하세요.</p></details>
          </aside>
          </div>
        </>
      )}
    </>
  )
}

export function OpenedFiles({ bundle }: { bundle: OpenedBundle }) {
  const [preview, setPreview] = useState<string | null>(null)
  const [requested, setRequested] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  return (
    <>
      <div className="summary flow-summary">
        <Check aria-hidden="true" />
        <div>
          <strong>{bundle.projectLabel}</strong>
          <p>
            {bundle.environment} · {bundle.files.length}개 파일 ·{' '}
            {new Date(bundle.createdAt).toLocaleString('ko-KR')}
          </p>
        </div>
      </div>
      <p className="help">다운로드한 파일은 아래 경로에 직접 넣어주세요. 브라우저에서 자동으로 적용하지 않아요.</p>
      <div className="received-files flow-file-list">
        {bundle.files.map((file) => {
          const content = preview === file.path ? previewText(file.bytes) : null
          return (
            <section className="received-file flow-section" key={file.path}>
              <div className="received-row">
                <File aria-hidden="true" />
                <div className="file-details">
                  <h2 className="mono">{file.path.split('/').at(-1)}</h2>
                  <p>
                    {formatSize(file.bytes.byteLength)}
                    {requested.includes(file.path) ? ' · 다운로드 요청함' : ''}
                  </p>
                </div>
                <div className="file-actions">
                  <button
                    type="button"
                    className="text-button"
                    aria-expanded={preview === file.path}
                    onClick={() => setPreview(preview === file.path ? null : file.path)}
                  >
                    {preview === file.path ? '내용 숨기기' : '내용 보기'}
                  </button>
                  <button
                    className="button"
                    type="button"
                    aria-label={`${file.path} 다운로드`}
                    onClick={() => {
                      downloadFile(file.bytes.buffer, file.path.split('/').at(-1)!)
                      setRequested((current) =>
                        current.includes(file.path) ? current : [...current, file.path],
                      )
                      setNotice(`${file.path} 다운로드를 요청했어요. 브라우저의 저장 결과를 확인해주세요.`)
                    }}
                  >
                    <Download aria-hidden="true" />
                    <span>다운로드</span>
                  </button>
                </div>
              </div>
              <CopyField value={file.path} label="Git 저장소 루트 기준 배치 경로" />
              {bundle.files.some(other => other.path !== file.path && other.path.split('/').at(-1) === file.path.split('/').at(-1)) && (
                <Notice>같은 이름의 파일이 다른 경로에도 있어요. 브라우저가 이름에 숫자를 붙일 수 있으니 저장 결과를 확인하고, 이 경로에 원래 이름으로 넣으세요.</Notice>
              )}
              {preview === file.path && (
                <div className="preview">
                  {content ? (
                    <>
                      <pre tabIndex={0} aria-label={`${file.path} 내용`}>
                        {content.text || '(빈 파일)'}
                      </pre>
                      {content.truncated && (
                        <p className="help">
                          미리보기는 앞의 16,384자만 표시해요. 다운로드에는 전체 원본이 들어 있어요.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="muted">텍스트로 표시할 수 없는 파일이에요. 원본 파일을 다운로드해주세요.</p>
                  )}
                </div>
              )}
            </section>
          )
        })}
      </div>
      <p role="status" className="field-status">
        {notice}
      </p>
    </>
  )
}

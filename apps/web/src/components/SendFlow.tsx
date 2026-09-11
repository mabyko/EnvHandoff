import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Download, File, FilePlus2, LockKeyhole, Radio, Trash2 } from 'lucide-react'
import { createBundle, explainError, LIMITS, validateFiles } from '../lib/bundle.ts'
import type { SealedBundle, SourceFile } from '../lib/bundle.ts'
import { downloadFile, formatSize } from '../lib/files.ts'
import { CopyField, Heading, Notice, Steps } from './ui.tsx'
import { LiveSender } from './live.tsx'

type PickedFile = SourceFile & { id: number; selected: boolean }

export function SendFlow({ onHome }: { onHome: () => void }) {
  const [step, setStep] = useState(0)
  const [files, setFiles] = useState<PickedFile[]>([])
  const [project, setProject] = useState('')
  const [environment, setEnvironment] = useState('development')
  const [method, setMethod] = useState<'file' | 'live'>('file')
  const [sealed, setSealed] = useState<SealedBundle | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const epoch = useRef(0)
  const nextId = useRef(0)
  useEffect(
    () => () => {
      epoch.current++
    },
    [],
  )
  const selected = files.filter((file) => file.selected)
  const total = selected.reduce((sum, item) => sum + item.file.size, 0)
  const edit = () => {
    epoch.current++
    setSealed(null)
    setError('')
  }
  const back = (target: number) => {
    epoch.current++
    setBusy(false)
    setError('')
    setStep(target)
  }
  const addFiles = (incoming: FileList | null) => {
    if (!incoming?.length) return
    if (files.length + incoming.length > LIMITS.files) {
      setError('최대 100개까지 추가할 수 있어요.')
      return
    }
    edit()
    setFiles([
      ...files,
      ...Array.from(incoming, (file) => ({ file, path: file.name, id: nextId.current++, selected: true })),
    ])
  }
  const check = () => {
    try {
      validateFiles(selected.map(({ path, file }) => ({ path, size: file.size })))
      setError('')
      setStep(1)
    } catch (reason) {
      setError(explainError(reason))
    }
  }
  const seal = async () => {
    const operation = ++epoch.current
    setBusy(true)
    setError('')
    try {
      const result = sealed ?? (await createBundle(selected, project, environment))
      if (operation !== epoch.current) return
      setSealed(result)
      setStep(2)
    } catch (reason) {
      if (operation === epoch.current) setError(explainError(reason))
    } finally {
      if (operation === epoch.current) setBusy(false)
    }
  }

  return (
    <>
      <Steps
        labels={['보낼 파일', '공유 방식', '전달하기']}
        current={step}
        onBack={busy ? undefined : back}
      />
      {step === 0 && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            check()
          }}
        >
          <Heading title="어떤 파일을 보낼까요?">
            필요한 설정 파일을 고르고, 받을 사람이 둘 경로를 확인해주세요.
          </Heading>
          <div className="fields two-columns">
            <div className="field">
              <label htmlFor="project">프로젝트 표시명</label>
              <input
                id="project"
                value={project}
                onChange={(event) => {
                  edit()
                  setProject(event.target.value)
                }}
                placeholder="예: my-project"
                required
                maxLength={80}
                autoComplete="off"
              />
              <p className="help">받는 사람이 알아볼 수 있는 이름</p>
            </div>
            <div className="field">
              <label htmlFor="environment">환경 이름</label>
              <input
                id="environment"
                value={environment}
                onChange={(event) => {
                  edit()
                  setEnvironment(event.target.value)
                }}
                required
                maxLength={48}
                autoComplete="off"
              />
              <p className="help">예: development, staging</p>
            </div>
          </div>
          <label className={`file-picker ${files.length ? 'compact' : ''}`}>
            <FilePlus2 aria-hidden="true" />
            <strong>{files.length ? '파일 더 추가하기' : '보낼 파일 선택'}</strong>
            <span>파일당 1 MiB · 전체 10 MiB · 최대 100개</span>
            <input
              type="file"
              multiple
              aria-label="보낼 파일 선택"
              onChange={(event) => {
                addFiles(event.target.files)
                event.target.value = ''
              }}
            />
          </label>
          {files.length > 0 && (
            <section className="file-list" aria-label="보낼 파일 목록">
              <div className="file-list-header">
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={selected.length === files.length}
                    onChange={(event) => {
                      edit()
                      setFiles(files.map((item) => ({ ...item, selected: event.target.checked })))
                    }}
                  />
                  전체 선택
                </label>
                <span>
                  {selected.length}개 · {formatSize(total)}
                </span>
              </div>
              {files.map((item) => (
                <div className="picked-file" key={item.id}>
                  <label className="check-label file-select">
                    <input
                      type="checkbox"
                      checked={item.selected}
                      aria-label={`${item.file.name} 선택`}
                      onChange={(event) => {
                        edit()
                        setFiles(
                          files.map((file) =>
                            file.id === item.id ? { ...file, selected: event.target.checked } : file,
                          ),
                        )
                      }}
                    />
                    <File aria-hidden="true" />
                  </label>
                  <div className="file-details">
                    <div className="file-name">
                      <span className="mono">{item.file.name}</span>
                      <span>{formatSize(item.file.size)}</span>
                    </div>
                    <label className="sr-only" htmlFor={`path-${item.id}`}>
                      {item.file.name} 공유 경로
                    </label>
                    <input
                      id={`path-${item.id}`}
                      className="mono path-input"
                      value={item.path}
                      onChange={(event) => {
                        edit()
                        setFiles(
                          files.map((file) =>
                            file.id === item.id ? { ...file, path: event.target.value } : file,
                          ),
                        )
                      }}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`${item.file.name} 제거`}
                    onClick={() => {
                      edit()
                      setFiles(files.filter((file) => file.id !== item.id))
                    }}
                  >
                    <Trash2 />
                  </button>
                </div>
              ))}
            </section>
          )}
          <p className="help spaced">
            공유 경로는 프로젝트 폴더 기준이에요. 하위 폴더가 필요하면 <code>config/.env</code>처럼
            수정해주세요.
          </p>
          {error && <Notice error>{error}</Notice>}
          <div className="actions">
            <span className="muted">선택한 파일만 공유해요.</span>
            <button className="button primary" type="submit" disabled={!selected.length}>
              다음
              <ArrowRight aria-hidden="true" />
            </button>
          </div>
        </form>
      )}
      {step === 1 && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void seal()
          }}
        >
          <Heading title="어떻게 전달할까요?">파일과 공유 코드를 나눠서 전달해요.</Heading>
          <div className="summary">
            <File aria-hidden="true" />
            <div>
              <strong>{project}</strong>
              <p>
                {environment} · {selected.length}개 파일 · {formatSize(total)}
              </p>
            </div>
            <LockKeyhole aria-hidden="true" />
          </div>
          <fieldset className="method-options" disabled={busy}>
            <legend className="sr-only">공유 방식</legend>
            <label className={`method-option ${method === 'file' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="method"
                value="file"
                checked={method === 'file'}
                onChange={() => setMethod('file')}
              />
              <File aria-hidden="true" />
              <span>
                <strong>공유 파일로 전달</strong>
                <small>암호화 파일을 내려받아 AirDrop이나 메신저로 보내요.</small>
                <span className="tag">서로 접속 시간이 달라도 괜찮아요</span>
              </span>
            </label>
            <label className={`method-option ${method === 'live' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="method"
                value="live"
                checked={method === 'live'}
                onChange={() => setMethod('live')}
              />
              <Radio aria-hidden="true" />
              <span>
                <strong>실시간으로 전달</strong>
                <small>연결 링크를 보내고, 상대를 확인한 뒤 바로 전달해요.</small>
                <span className="tag">두 사람 모두 이 화면을 열어두세요</span>
              </span>
            </label>
          </fieldset>
          <Notice>공유 코드는 파일을 여는 열쇠예요. 파일·연결 링크와 다른 대화 경로로 전달해주세요.</Notice>
          {error && <Notice error>{error}</Notice>}
          <div className="actions">
            <button className="button" type="button" onClick={() => back(0)}>
              <ArrowLeft aria-hidden="true" />
              이전
            </button>
            <button className="button primary" type="submit" disabled={busy}>
              {busy ? '암호화하는 중…' : '암호화하고 준비하기'}
              <LockKeyhole aria-hidden="true" />
            </button>
          </div>
        </form>
      )}
      {step === 2 &&
        sealed &&
        (method === 'live' ? (
          <LiveSender sealed={sealed} onFallback={() => setMethod('file')} onHome={onHome} />
        ) : (
          <FileDelivery sealed={sealed} onHome={onHome} />
        ))}
    </>
  )
}

function FileDelivery({ sealed, onHome }: { sealed: SealedBundle; onHome: () => void }) {
  const [requested, setRequested] = useState(false)
  return (
    <>
      <Heading title="이제 파일과 코드를 건네주세요">
        암호화 파일이 준비됐어요. 두 가지만 전달하면 돼요.
      </Heading>
      <section className="task-card">
        <span className="task-number">1</span>
        <div>
          <h2>공유 파일 전달하기</h2>
          <p className="muted">내려받은 파일을 AirDrop·메신저·이메일 첨부로 보내주세요.</p>
          <div className="download-card">
            <File aria-hidden="true" />
            <div>
              <strong className="mono">{sealed.filename}</strong>
              <p>
                {sealed.fileCount}개 파일 · {formatSize(sealed.bytes.byteLength)}
              </p>
            </div>
          </div>
          <button
            className="button primary"
            type="button"
            onClick={() => {
              downloadFile(sealed.bytes, sealed.filename)
              setRequested(true)
            }}
          >
            <Download aria-hidden="true" />
            {requested ? '다시 다운로드' : '공유 파일 다운로드'}
          </button>
          <p className="field-status" role="status">
            {requested ? '다운로드를 요청했어요. 저장된 파일을 확인해서 전달해주세요.' : ''}
          </p>
        </div>
      </section>
      <section className="task-card">
        <span className="task-number">2</span>
        <div>
          <h2>공유 코드는 따로 전달하기</h2>
          <p className="muted">파일을 보낸 곳과 다른 대화 경로로 공유해주세요.</p>
          <CopyField value={sealed.code} label="이 파일의 공유 코드" secret />
        </div>
      </section>
      <Notice>파일과 코드의 복사·다운로드만으로 상대의 수신 여부를 확인할 수는 없어요.</Notice>
      <div className="actions end">
        <button type="button" className="button" onClick={onHome}>
          작업 마치기
        </button>
      </div>
    </>
  )
}

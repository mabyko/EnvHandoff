import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Download, File, FilePlus2, LockKeyhole, Plus, Radio, Trash2 } from 'lucide-react'
import { createBundle, explainError, LIMITS, validateFiles } from '../lib/bundle.ts'
import type { SealedBundle, SourceFile } from '../lib/bundle.ts'
import { downloadFile, formatSize } from '../lib/files.ts'
import { createEnvFile, parseEditableEnv, previewEnvEdit } from '../lib/env.ts'
import type { EditableEnv } from '../lib/env.ts'
import { CopyField, Heading, Notice, Steps } from './ui.tsx'
import { LiveSender } from './live.tsx'

type PickedFile = SourceFile & { id: number; selected: boolean }
type EnvDraft = { id: number; source: EditableEnv; values: string[]; preview: ReturnType<typeof previewEnvEdit> | null; error: string }

export function SendFlow({ onHome }: { onHome: () => void }) {
  const [step, setStep] = useState(0)
  const [files, setFiles] = useState<PickedFile[]>([])
  const [project, setProject] = useState('')
  const [environment, setEnvironment] = useState('development')
  const [method, setMethod] = useState<'file' | 'live'>('file')
  const [sealed, setSealed] = useState<SealedBundle | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [envRows, setEnvRows] = useState([{ id: 0, key: '', value: '' }])
  const [envError, setEnvError] = useState('')
  const [envAdded, setEnvAdded] = useState(false)
  const [envDraft, setEnvDraft] = useState<EnvDraft | null>(null)
  const [envEditLoading, setEnvEditLoading] = useState<number | null>(null)
  const [envEditNotice, setEnvEditNotice] = useState('')
  const envEditor = useRef<HTMLDetailsElement>(null)
  const epoch = useRef(0)
  const nextId = useRef(1)
  useEffect(() => {
    const operationEpoch = epoch
    const preventFileNavigation = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'none'
      if (event.type === 'drop') setDragging(false)
    }
    window.addEventListener('dragover', preventFileNavigation)
    window.addEventListener('drop', preventFileNavigation)
    return () => {
      operationEpoch.current++
      window.removeEventListener('dragover', preventFileNavigation)
      window.removeEventListener('drop', preventFileNavigation)
    }
  }, [])
  const selected = files.filter((file) => file.selected)
  const total = selected.reduce((sum, item) => sum + item.file.size, 0)
  const edit = () => {
    epoch.current++
    setSealed(null)
    setError('')
    setEnvDraft(null)
    setEnvEditLoading(null)
    setEnvEditNotice('')
  }
  const back = (target: number) => {
    epoch.current++
    setBusy(false)
    setError('')
    setStep(target)
  }
  const addFiles = (incoming: FileList | File[] | null) => {
    if (!incoming?.length) return false
    if (files.length + incoming.length > LIMITS.files) {
      setError('최대 100개까지 추가할 수 있어요.')
      return false
    }
    edit()
    setFiles([
      ...files,
      ...Array.from(incoming, (file) => ({ file, path: file.name, id: nextId.current++, selected: true })),
    ])
    return true
  }
  const editEnv = () => {
    edit()
    setEnvError('')
    setEnvAdded(false)
  }
  const addEnv = () => {
    try {
      const file = createEnvFile(envRows)
      if (!addFiles([file])) return
      setEnvRows([{ id: nextId.current++, key: '', value: '' }])
      setEnvError('')
      setEnvAdded(true)
    } catch (reason) {
      setEnvError(explainError(reason))
    }
  }
  const openEnvEdit = async (item: PickedFile) => {
    const operation = ++epoch.current
    setEnvEditLoading(item.id)
    setError('')
    setEnvEditNotice('')
    try {
      const source = parseEditableEnv(new Uint8Array(await item.file.arrayBuffer()))
      if (operation === epoch.current) setEnvDraft({ id: item.id, source, values: source.entries.map(({ value }) => value), preview: null, error: '' })
    } catch (reason) {
      if (operation === epoch.current) setError(explainError(reason))
    } finally {
      if (operation === epoch.current) setEnvEditLoading(null)
    }
  }
  const saveEnvEdit = () => {
    if (!envDraft?.preview) return
    const item = files.find(({ id }) => id === envDraft.id)
    if (!item) return
    try {
      const file = new globalThis.File([envDraft.preview.text], item.file.name, { type: item.file.type })
      validateFiles([{ path: item.path, size: file.size }])
      edit()
      setFiles(files.map((current) => current.id === item.id ? { ...current, file } : current))
      setEnvDraft(null)
      setEnvEditNotice(`${item.file.name} 변경 내용을 공유할 파일 목록에 적용했어요.`)
    } catch (reason) {
      setEnvDraft({ ...envDraft, error: explainError(reason) })
    }
  }
  const check = () => {
    if (envRows.some(({ key, value }) => key !== '' || value !== '')) {
      setEnvError('입력한 환경변수를 .env 파일로 추가하거나 입력을 지운 뒤 다음으로 넘어가주세요.')
      if (envEditor.current) envEditor.current.open = true
      document.getElementById(`env-key-${envRows[0].id}`)?.focus()
      return
    }
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
          <label
            className={`file-picker ${files.length ? 'compact' : ''} ${dragging ? 'dragging' : ''}`}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes('Files')) return
              event.preventDefault()
              event.stopPropagation()
              event.dataTransfer.dropEffect = 'copy'
              setDragging(true)
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
            }}
            onDrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setDragging(false)
              if (Array.from(event.dataTransfer.items).some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
                setError('폴더 대신 공유할 파일을 선택해서 끌어다 놓아주세요.')
                return
              }
              addFiles(event.dataTransfer.files)
            }}
          >
            <FilePlus2 aria-hidden="true" />
            <strong>{dragging ? '여기에 파일을 놓아주세요' : '파일을 끌어다 놓거나 눌러서 선택'}</strong>
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
          <details className="env-editor" ref={envEditor}>
            <summary>환경변수 직접 입력</summary>
            <p className="help" id="env-help">
              파일이 없어도 키와 값을 입력해 공유할 수 있어요. 값은 따옴표로 감싸지 말고 그대로 입력해주세요.
            </p>
            <div className="env-rows">
              {envRows.map((row, index) => (
                <div className="env-row" key={row.id}>
                  <div className="field">
                    <label htmlFor={`env-key-${row.id}`}>키 <span className="sr-only">{index + 1}</span></label>
                    <input
                      id={`env-key-${row.id}`}
                      className="mono"
                      value={row.key}
                      placeholder="API_KEY"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      onChange={(event) => {
                        editEnv()
                        setEnvRows(envRows.map((item) => item.id === row.id ? { ...item, key: event.target.value } : item))
                      }}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`env-value-${row.id}`}>값 <span className="sr-only">{index + 1}</span></label>
                    <textarea
                      id={`env-value-${row.id}`}
                      className="mono"
                      value={row.value}
                      rows={2}
                      placeholder="값 (빈 값도 가능)"
                      aria-describedby="env-help"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      onChange={(event) => {
                        editEnv()
                        setEnvRows(envRows.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item))
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`환경변수 ${index + 1} 삭제`}
                    onClick={() => {
                      editEnv()
                      setEnvRows(envRows.length === 1
                        ? [{ id: row.id, key: '', value: '' }]
                        : envRows.filter((item) => item.id !== row.id))
                      const adjacent = envRows[index + 1] ?? envRows[index - 1] ?? row
                      document.getElementById(`env-key-${adjacent.id}`)?.focus()
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
            {envError && <Notice error>{envError}</Notice>}
            <div className="env-actions">
              <button
                type="button"
                className="button"
                onClick={() => {
                  editEnv()
                  setEnvRows([...envRows, { id: nextId.current++, key: '', value: '' }])
                }}
              >
                <Plus aria-hidden="true" />변수 추가
              </button>
              <button type="button" className="button" onClick={addEnv}>.env 파일로 추가</button>
            </div>
            <p className="help" role="status">{envAdded ? '.env 파일을 아래 목록에 추가했어요. 공유 경로를 확인해주세요.' : ''}</p>
          </details>
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
                    <label className="help" htmlFor={`path-${item.id}`}>
                      {item.file.name}의 Git 저장소 루트 기준 배치 경로
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
                    {/^\.env(?:\..+)?$/.test(item.file.name) && (
                      <button type="button" className="text-button" disabled={envEditLoading !== null} onClick={() => void openEnvEdit(item)}>
                        {envEditLoading === item.id ? '읽는 중…' : '기존 .env 변수 편집'}
                      </button>
                    )}
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
              {envDraft && (
                <div className="preview env-file-editor">
                  <h2>{files.find(({ id }) => id === envDraft.id)?.file.name} 변수 편집</h2>
                  <p className="help">원본의 주석·줄바꿈·변경하지 않은 값은 유지해요. 모호한 구문은 파일 전체를 다시 올려주세요.</p>
                  <div className="env-rows">
                    {envDraft.source.entries.map((entry, index) => (
                      <div className="fields two-columns" key={entry.key}>
                        <div className="field"><label htmlFor={`edit-key-${index}`}>변수</label><input id={`edit-key-${index}`} className="mono" value={entry.key} readOnly /></div>
                        <div className="field"><label htmlFor={`edit-value-${index}`}>{entry.key} 값</label><textarea id={`edit-value-${index}`} className="mono" rows={2} value={envDraft.values[index]} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(event) => setEnvDraft({ ...envDraft, values: envDraft.values.map((value, i) => i === index ? event.target.value : value), preview: null, error: '' })} /></div>
                      </div>
                    ))}
                  </div>
                  {envDraft.error && <Notice error>{envDraft.error}</Notice>}
                  <div className="env-actions">
                    <button type="button" className="button" onClick={() => {
                      try { setEnvDraft({ ...envDraft, preview: previewEnvEdit(envDraft.source, envDraft.values), error: '' }) }
                      catch (reason) { setEnvDraft({ ...envDraft, preview: null, error: explainError(reason) }) }
                    }}>변경 미리보기</button>
                    <button type="button" className="button" onClick={() => setEnvDraft(null)}>취소</button>
                  </div>
                  {envDraft.preview && (
                    <div className="preview">
                      <p>변경된 줄</p>
                      <pre tabIndex={0} aria-label="변경 전후 줄">{envDraft.source.entries.flatMap((entry, index) => envDraft.values[index] === entry.value ? [] : [`- ${entry.key}=${entry.quote ? `${entry.quote}${entry.value}${entry.quote}` : entry.value}`, `+ ${entry.key}=${entry.quote ? `${entry.quote}${envDraft.values[index]}${entry.quote}` : envDraft.values[index]}`]).join('\n')}</pre>
                      <p>결과 파일</p>
                      <pre tabIndex={0} aria-label="수정된 .env 파일 내용">{envDraft.preview.text.slice(0, 16384)}</pre>
                      {envDraft.preview.text.length > 16384 && <p className="help">미리보기는 앞의 16,384자만 표시해요. 공유 파일에는 전체 내용이 들어가요.</p>}
                      <button type="button" className="button" onClick={saveEnvEdit}>변경 적용</button>
                    </div>
                  )}
                </div>
              )}
              <p className="help" role="status">{envEditNotice}</p>
            </section>
          )}
          <p className="help spaced">
            배치 경로는 보내는 프로젝트의 Git 저장소 루트 기준 상대 경로예요. 예를 들어 저장소의{' '}
            <code>config/.env</code> 파일은 <code>config/.env</code>로 적어주세요. 브라우저는 Git 루트를 자동으로 찾지 않아요.
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

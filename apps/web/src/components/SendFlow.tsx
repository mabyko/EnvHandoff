import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Download, File, FilePlus2, Plus, Radio, Trash2 } from 'lucide-react'
import { createBundle, explainError, LIMITS, validateFiles } from '../lib/bundle.ts'
import type { SealedBundle, SourceFile } from '../lib/bundle.ts'
import { downloadFile, formatSize } from '../lib/files.ts'
import { createEnvFile, parseEditableEnv, previewEnvEdit } from '../lib/env.ts'
import type { EditableEnv } from '../lib/env.ts'
import { CopyField, Heading, Notice, Steps } from './ui.tsx'
import { LiveSender } from './live.tsx'
import { useWorkLoss } from '../lib/work-loss.ts'

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
  const hasWork = !!files.length || !!sealed || busy || !!project || environment !== 'development' || envRows.some(row => !!row.key || !!row.value) || !!envDraft
  useWorkLoss(hasWork)
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
    if (busy || !incoming?.length) return false
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
      void seal()
    } catch (reason) {
      setError(explainError(reason))
    }
  }
  const seal = async () => {
    const operation = ++epoch.current
    setBusy(true)
    setError('')
    try {
      const result = sealed ?? (await createBundle(selected, project.trim() || '설정 공유', environment.trim() || 'development'))
      if (operation !== epoch.current) return
      setSealed(result)
      setStep(1)
    } catch (reason) {
      if (operation === epoch.current) setError(explainError(reason))
    } finally {
      if (operation === epoch.current) setBusy(false)
    }
  }

  return (
    <>
      <span hidden data-work-loss={hasWork} />
      <Steps
        labels={['파일 선택', '전달하기']}
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
          <Heading title="설정 파일 보내기">
            파일을 고르고, 받는 사람이 넣을 경로를 확인하세요.
          </Heading>
          <fieldset className="plain-fieldset flow-layout" disabled={busy}>
            <div className="flow-main">
            <section className="flow-section" aria-labelledby="send-files-heading">
              <div className="flow-section-header">
                <h2 id="send-files-heading">보낼 파일</h2>
                <span className="muted">{selected.length ? `${selected.length}개 · ${formatSize(total)}` : '.env · 개발 설정 파일'}</span>
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
              <strong>{dragging ? '여기에 파일을 놓아주세요' : files.length ? '파일 추가' : '파일을 끌어다 놓거나 선택하세요'}</strong>
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
              <section className="file-list flow-file-list" aria-label="보낼 파일 목록">
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
                        배치 경로 <span className="sr-only">· {item.file.name} · Git 저장소 루트 기준</span>
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
            </section>
            <details className="env-editor flow-options" ref={envEditor}>
              <summary>파일 없이 .env 만들기</summary>
              <p className="help" id="env-help">
                키와 값을 입력하면 보낼 파일 목록에 .env를 추가해요. 값은 따옴표 없이 입력하세요.
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
              <p className="help" role="status">{envAdded ? '.env 파일을 목록에 추가했어요. 배치 경로를 확인해주세요.' : ''}</p>
            </details>
            {files.length > 0 && (
              <p className="help spaced">
                배치 경로는 Git 저장소 루트 기준이에요. 예: <code>apps/api/.env</code>. 받는 사람이 이 위치에 직접 넣어요.
              </p>
            )}
            {error && <Notice error>{error}</Notice>}
            <div className="actions flow-toolbar">
              <span className="muted">선택한 파일만 공유해요.</span>
              <button className="button primary" type="submit" disabled={!selected.length || busy}>
                {busy ? '암호화하는 중…' : method === 'live' ? '실시간 전달 준비' : '공유 파일 만들기'}
                <ArrowRight aria-hidden="true" />
              </button>
            </div>
            </div>
            <aside className="flow-aside" aria-label="공유 옵션">
              <div className="flow-section-header"><h2>전달 준비</h2></div>
              <p className="help">파일은 이 브라우저에서 암호화해요. 만든 공유 파일과 코드를 상대에게 보내면 돼요.</p>
            <details className="share-options flow-options">
              <summary>이름과 환경 <span>선택 입력</span></summary>
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
                    placeholder="설정 공유 (선택 입력)"
                    maxLength={80}
                    autoComplete="off"
                  />
                  <p className="help">비워두면 ‘설정 공유’로 표시해요.</p>
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
                    maxLength={48}
                    autoComplete="off"
                  />
                  <p className="help">예: development, staging</p>
                </div>
              </div>
            </details>
            <details className="flow-options">
              <summary>전달 방식 <span>{method === 'live' ? '실시간 연결' : '공유 파일'}</span></summary>
            <fieldset className="method-options" disabled={busy}>
              <legend>전달 방식</legend>
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
                  <strong>공유 파일</strong>
                  <small>내려받아 메신저·AirDrop으로 전달</small>
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
                  <strong>실시간 연결</strong>
                  <small>둘 다 접속한 상태에서 상대를 확인하고 전달</small>
                </span>
              </label>
            </fieldset>
            </details>
            </aside>
          </fieldset>
        </form>
      )}
      {step === 1 &&
        sealed &&
        (method === 'live' ? (
          <div className="flow-result">
            <LiveSender sealed={sealed} onFallback={() => setMethod('file')} onHome={onHome} />
          </div>
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
        공유 파일을 보내고, 코드는 다른 대화 경로로 전달하세요.
      </Heading>
      <div className="flow-layout">
      <div className="flow-main flow-result">
      <section className="task-card flow-section">
        <div>
          <div className="flow-section-header"><h2>1. 공유 파일 보내기</h2></div>
          <div className="download-card flow-file-list">
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
      <section className="task-card flow-section">
        <div>
          <div className="flow-section-header"><h2>2. 공유 코드 따로 보내기</h2></div>
          <p className="help">파일을 메신저로 보냈다면 코드는 전화 등 다른 경로로 알려주세요.</p>
          <CopyField value={sealed.code} label="이 파일의 공유 코드" secret />
        </div>
      </section>
      <div className="actions end flow-toolbar">
        <button type="button" className="button" onClick={onHome}>
          작업 마치기
        </button>
      </div>
      </div>
      <aside className="flow-aside" aria-label="받는 사람 안내">
        <div className="flow-section-header"><h2>받는 사람은</h2></div>
        <p className="help">EnvHandoff에서 공유 파일을 선택하고 코드를 입력하면 원본 파일과 배치 경로를 볼 수 있어요.</p>
        <p className="help">복사·다운로드만으로 상대의 수신 여부를 확인할 수는 없어요.</p>
      </aside>
      </div>
    </>
  )
}

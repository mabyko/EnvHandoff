import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, CircleAlert, Copy, Eye, EyeOff, Info } from 'lucide-react'

export function Heading({ title, children }: { title: string; children?: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [title])
  return (
    <div className="heading">
      <h1 ref={ref} tabIndex={-1}>
        {title}
      </h1>
      {children && <p className="lead">{children}</p>}
    </div>
  )
}

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div className={`notice ${error ? 'error' : ''}`} role={error ? 'alert' : undefined}>
      {error ? <CircleAlert aria-hidden="true" /> : <Info aria-hidden="true" />}
      <div>{children}</div>
    </div>
  )
}

export function Steps({
  labels,
  current,
  onBack,
}: {
  labels: string[]
  current: number
  onBack?: (step: number) => void
}) {
  return (
    <nav aria-label="진행 단계" className="steps">
      <ol>
        {labels.map((label, index) => (
          <li
            key={label}
            aria-current={index === current ? 'step' : undefined}
            className={index < current ? 'done' : ''}
          >
            <button type="button" disabled={!onBack || index >= current} onClick={() => onBack?.(index)}>
              <span className="step-number">
                {index < current ? <Check aria-hidden="true" /> : index + 1}
              </span>
              <span>{label}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

export function CopyField({
  value,
  label,
  secret = false,
}: {
  value: string
  label: string
  secret?: boolean
}) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [shown, setShown] = useState(false)
  const [status, setStatus] = useState('')
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setStatus('복사했어요.')
    } catch {
      setShown(true)
      setStatus('자동 복사가 안 돼요. 선택된 내용을 직접 복사해주세요.')
      requestAnimationFrame(() => {
        input.current?.focus()
        input.current?.select()
      })
    }
  }
  return (
    <div className="copy-field">
      <label htmlFor={id}>{label}</label>
      <div className="copy-controls">
        <input
          id={id}
          ref={input}
          readOnly
          value={value}
          type={secret && !shown ? 'password' : 'text'}
          autoComplete="off"
          spellCheck={false}
          className="mono"
        />
        {secret && (
          <button
            type="button"
            className="icon-button"
            aria-label={shown ? '공유 코드 숨기기' : '공유 코드 표시'}
            aria-pressed={shown}
            onClick={() => setShown(!shown)}
          >
            {shown ? <EyeOff /> : <Eye />}
          </button>
        )}
        <button type="button" className="button" onClick={copy}>
          <Copy aria-hidden="true" />
          복사
        </button>
      </div>
      <p className="field-status" role="status">
        {status}
      </p>
    </div>
  )
}

export function CodeInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [shown, setShown] = useState(false)
  const id = useId()
  return (
    <div className="field">
      <label htmlFor={id}>공유 코드</label>
      <div className="copy-controls">
        <input
          id={id}
          name="share-code"
          className="mono"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          type={shown ? 'text' : 'password'}
          placeholder="별도로 받은 43자리 코드"
          maxLength={128}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
        <button
          type="button"
          className="icon-button"
          onClick={() => setShown(!shown)}
          aria-label={shown ? '입력한 코드 숨기기' : '입력한 코드 표시'}
          aria-pressed={shown}
        >
          {shown ? <EyeOff /> : <Eye />}
        </button>
      </div>
      <p className="help">파일이나 연결 링크를 받은 곳과 다른 대화 경로로 받아주세요.</p>
    </div>
  )
}

export function Progress({ percent }: { percent: number }) {
  return (
    <div className="transfer-progress">
      <progress max={100} value={percent} aria-label="암호화 파일 전송" />
      <div>
        <span>암호화 파일 전송</span>
        <span>{percent}%</span>
      </div>
    </div>
  )
}

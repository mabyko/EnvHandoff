import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { CopyField } from './ui.tsx'

export type BetaStatus = { active: boolean; operator: boolean; owned: number; workspaceLimit: number }
type Code = { id: string; label: string; maxUses: number; used: number; expiresAt: number; revoked: number }
type Call = (path: string, body?: Record<string, unknown>) => Promise<unknown>

export function ProBeta({ status, busy, call, run, onActivated, onCreate, onSettings }: {
  status: BetaStatus; busy: boolean; call: Call; run: (action: () => Promise<void>) => Promise<void>;
  onActivated: (status: BetaStatus) => void; onCreate: () => void; onSettings: () => void;
}) {
  const [code, setCode] = useState(''), [label, setLabel] = useState(''), [maxUses, setMaxUses] = useState('10'), [days, setDays] = useState('7')
  const [codes, setCodes] = useState<Code[]>([]), [issued, setIssued] = useState(''), [revoke, setRevoke] = useState<Code | null>(null)
  const loaded = useRef(false)
  const [now, setNow] = useState(() => Date.now())
  const refresh = useCallback(async () => { setCodes(await call('/beta/codes') as Code[]); setNow(Date.now()) }, [call])
  // The parent owns request cancellation and session/error handling.
  useEffect(() => {
    if (status.operator && !busy && !loaded.current) {
      loaded.current = true
      void run(refresh)
    }
  }, [status.operator, busy, run, refresh])
  return <section className="pro-page">
    <header className="pro-page-header"><div><span className="pro-badge">{status.operator ? '운영자' : '무료 베타'}</span><h2>{status.operator ? '베타 참여 관리' : 'Pro Beta 참여하기'}</h2><p>베타 코드는 워크스페이스 개설 권한을 활성화해요. 다른 워크스페이스 참여에는 별도의 초대가 필요해요.</p></div></header>
    {status.active ? <div className="pro-welcome-card"><ShieldCheck aria-hidden="true" /><div><h3>Pro Beta가 활성화됐어요</h3><p>소유 워크스페이스 {status.owned} / {status.workspaceLimit}개 · 초대받아 참여한 워크스페이스는 별도예요.</p><button className="button primary" disabled={busy || status.owned >= status.workspaceLimit} onClick={onCreate}>워크스페이스 만들기</button></div></div> :
      <form className="pro-welcome-card pro-form" onSubmit={event => { event.preventDefault(); void run(async () => { onActivated(await call('/beta/redeem', { code }) as BetaStatus); setCode('') }) }}>
        <KeyRound aria-hidden="true" /><div><h3>베타 참여 코드를 입력하세요</h3><p>운영자에게 받은 베타 코드를 입력하면 내 워크스페이스를 최대 2개 만들 수 있어요. 워크스페이스 초대 링크는 ‘워크스페이스 참여’에서 수락해주세요.</p>
        <label htmlFor="beta-code">베타 참여 코드</label><input id="beta-code" value={code} required maxLength={64} autoComplete="off" spellCheck={false} onChange={event => setCode(event.target.value)} disabled={busy} />
        <button className="button primary" disabled={busy} type="submit">Pro Beta 활성화</button></div>
      </form>}
    {status.operator && <>
      <section className="pro-panel pro-code-panel"><h3>참여 코드 발급</h3><p className="help">코드는 지정한 인원만 사용할 수 있어요. 유효 기간이 끝나도 이미 참여한 계정의 자격은 유지돼요.</p>
        <p className="help">발급·취소 전 최근 15분 이내 본인 확인이 필요해요. <button type="button" className="text-button" onClick={onSettings}>내 설정에서 확인</button></p>
        <form className="pro-form" onSubmit={event => { event.preventDefault(); void run(async () => {
          const result = await call('/beta/codes', { label, maxUses: Number(maxUses), days: Number(days) }) as { code: string }
          setIssued(result.code); setLabel(''); await refresh()
        }) }}><fieldset className="plain-fieldset" disabled={busy}>
          <label htmlFor="beta-label">관리용 이름</label><input id="beta-label" value={label} onChange={event => setLabel(event.target.value)} required maxLength={80} placeholder="예: 첫 번째 테스트 그룹" />
          <div className="pro-form-columns"><div><label htmlFor="beta-uses">참여 가능 인원</label><input id="beta-uses" type="number" min={1} max={1000} required value={maxUses} onChange={event => setMaxUses(event.target.value)} /><small>1~1,000명 · 계정당 한 번</small></div>
          <div><label htmlFor="beta-days">발급 시점부터 유효 일수</label><input id="beta-days" type="number" min={1} max={365} required value={days} onChange={event => setDays(event.target.value)} /><small>1~365일 · 참여 신청 기한</small></div></div>
          <button className="button primary" type="submit">코드 발급</button>
        </fieldset></form>
        {issued && <div className="pro-confirm" role="status"><p>코드 원문은 지금만 볼 수 있어요. 복사해서 보관해주세요.</p><CopyField label="발급된 베타 코드" value={issued} /><button type="button" className="text-button" onClick={() => setIssued('')}>코드 숨기기</button></div>}
      </section>
      <section><div className="pro-page-heading"><h3>발급 내역</h3><button className="button" disabled={busy} onClick={() => { void run(refresh) }}>새로고침</button></div>
        {!codes.length && <p className="pro-empty">아직 발급한 코드가 없어요.</p>}
        <ul className="pro-list">{codes.map(item => {
          const state = item.revoked ? '취소됨' : item.expiresAt <= now ? '만료됨' : item.used >= item.maxUses ? '인원 마감' : '참여 가능'
          return <li key={item.id}><div className="pro-page-heading"><h4>{item.label}</h4><span className="pro-badge">{state}</span></div><p>{item.used} / {item.maxUses}명 참여 · {new Date(item.expiresAt).toLocaleString()}까지</p>
            {state === '참여 가능' && <button className="text-button" disabled={busy} onClick={() => setRevoke(item)}>코드 취소</button>}</li>
        })}</ul>
        {revoke && <div className="pro-confirm" role="group" aria-label="코드 취소 확인"><p>‘{revoke.label}’ 코드를 취소할까요? 새로운 참여만 막고, 기존 참여자의 자격은 유지해요.</p><div className="actions"><button className="button" disabled={busy} onClick={() => { void run(async () => { await call('/beta/codes/revoke', { id: revoke.id }); setRevoke(null); await refresh() }) }}>취소 확인</button><button className="button" disabled={busy} onClick={() => setRevoke(null)}>돌아가기</button></div></div>}
      </section>
    </>}
  </section>
}

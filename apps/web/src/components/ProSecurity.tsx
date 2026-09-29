import { useEffect, useRef, useState } from 'react'
import { startAuthentication, startRegistration, WebAuthnAbortService } from '@simplewebauthn/browser'
import QRCode from 'qrcode'
import { answerDeviceChallenge, deviceIdentity, identityFingerprint } from '@envhandoff/protocol/device-proof'
import type { DeviceAction, DeviceIdentity, EncryptedDeviceChallenge } from '@envhandoff/protocol/device-proof'
import { createLocalDevice, deleteLocalDevice, loadLocalDevice } from '../lib/device-keys.ts'
import type { LocalDevice } from '../lib/device-keys.ts'
import { CopyField, Notice } from './ui.tsx'

type Device = { identity: DeviceIdentity; status: 'pending' | 'active' | 'revoked'; fingerprint: string }
type Security = {
  passkeys: { id: string; label: string }[]; totp: boolean; totpAvailable: boolean; reauthenticatedUntil: number
  sessionHash: string; canRegisterDevice: boolean; devices: Device[]
}
const errors: Record<string, string> = {
  reauthentication_required: '패스키 또는 인증 앱으로 먼저 본인 확인을 해주세요.',
  fresh_login_required: '첫 인증 수단을 등록하려면 로그아웃 후 다시 로그인해주세요.',
  invalid_passkey: '패스키를 확인하지 못했어요. 다시 시도해주세요.',
  invalid_totp: '코드가 맞지 않거나 이미 사용됐어요. 인증 앱의 새 코드를 입력해주세요.',
  totp_exists: '인증 앱이 이미 등록돼 있어요.',
  totp_unavailable: '인증 앱을 사용할 수 없어요. 서버 설정 또는 등록 상태를 확인해주세요.',
  last_factor: '마지막 인증 수단은 삭제할 수 없어요. 다른 수단을 먼저 등록해주세요.',
  passkey_limit: '패스키가 이미 등록됐거나 5개 한도에 도달했어요.',
  challenge_expired: '확인 요청이 만료되거나 이미 사용됐어요. 처음부터 다시 시도해주세요.',
  membership_required: '활성 워크스페이스에 참여한 뒤 기기를 등록할 수 있어요.',
  device_action_failed: '기기 상태가 바뀌었거나 증명을 확인하지 못했어요. 목록을 새로고침해주세요.',
  last_owner: '마지막 Owner인 워크스페이스가 있어요. 팀 설정에서 Owner를 이전하거나 워크스페이스를 삭제한 뒤 다시 시도해주세요.',
  deletion_ledger_unavailable: '지금은 안전하게 삭제를 기록할 수 없어요. 잠시 후 다시 시도해주세요.',
}

export function ProSecurity({ api, userId, csrf, disabled, onExpired, onDeleted }: { api: string; userId: string; csrf: string; disabled: boolean; onExpired: () => void; onDeleted: (warning: string) => void }) {
  const [state, setState] = useState<Security | null>(null)
  const [local, setLocal] = useState<LocalDevice>()
  const [localFingerprint, setLocalFingerprint] = useState('')
  const [localError, setLocalError] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [name, setName] = useState('내 패스키')
  const [code, setCode] = useState('')
  const [setup, setSetup] = useState<{ id: string; secret: string; qr: string; expiresAt: number } | null>(null)
  const [selection, setSelection] = useState<{ action: 'approve' | 'revoke'; device: Device } | null>(null)
  const [fingerprint, setFingerprint] = useState('')
  const [deletion, setDeletion] = useState('')
  const lifetime = useRef(new AbortController())
  const expired = useRef(onExpired)
  expired.current = onExpired
  const mine = state?.devices.find(device => device.identity.deviceId === local?.deviceId)
  const locked = busy || disabled
  const removalReason = !state ? '' : state.passkeys.length + Number(state.totp) <= 1
    ? errors.last_factor
    : state.reauthenticatedUntil <= Date.now() ? '인증 수단을 삭제하려면 위에서 먼저 본인 확인을 해주세요.' : ''

  async function call(path: string, body?: Record<string, unknown>) {
    const response = await fetch(api + path, { method: body ? 'POST' : 'GET', credentials: 'include', redirect: 'error',
      headers: body ? { 'content-type': 'application/json', 'x-csrf-token': csrf } : {}, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(15_000)]) })
    if (response.status === 401) { if (!lifetime.current.signal.aborted) expired.current(); throw new Error('다시 로그인해주세요.') }
    if (response.status === 429) throw new Error('요청이 너무 많아요. 10분 후 다시 시도해주세요.')
    if (response.status === 204) return undefined
    const data = await response.json()
    if (!response.ok) throw new Error(errors[data.error as string] ?? '요청을 완료하지 못했어요. 새로고침 후 다시 시도해주세요.')
    return data
  }
  async function load() {
    try {
      const keys = await loadLocalDevice(userId)
      setLocal(keys); setLocalError('')
      setLocalFingerprint(keys ? await identityFingerprint(await deviceIdentity(userId, keys.deviceId, keys.keys.publicKey, keys.signingKeys.publicKey)) : '')
    }
    catch { setLocalError('이 브라우저의 기기 키를 읽지 못했어요. 저장소 권한을 확인하거나 새 브라우저에서 복구해주세요.') }
    setState(await call('/security') as Security)
  }
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void load().catch(() => { if (!controller.signal.aborted) setError('보안 설정을 불러오지 못했어요. 다시 조회해주세요.') }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => { controller.abort(); WebAuthnAbortService.cancelCeremony() }
    // This component is keyed by account and session; callbacks must not restart it on parent renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, userId, csrf])
  useEffect(() => {
    if (!setup) return
    const timer = setTimeout(() => { setSetup(null); setCode('') }, Math.max(0, setup.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [setup])
  useEffect(() => {
    if (!state?.reauthenticatedUntil) return
    const timer = setTimeout(() => setState(value => value ? { ...value, reauthenticatedUntil: 0 } : value), Math.max(0, state.reauthenticatedUntil - Date.now()))
    return () => clearTimeout(timer)
  }, [state?.reauthenticatedUntil])

  async function run(action: () => Promise<void>, success = '') {
    setBusy(true); setError(''); setMessage('')
    try { await action(); if (!lifetime.current.signal.aborted) { await load(); setMessage(success) } }
    catch (error) {
      if (!lifetime.current.signal.aborted) {
        setError(error instanceof Error && !['TypeError', 'TimeoutError', 'NotAllowedError', 'WebAuthnError'].includes(error.name) ? error.message : '처리가 취소됐거나 연결하지 못했어요. 상태를 조회한 뒤 다시 시도해주세요.')
        await load().catch(() => {})
      }
    } finally { if (!lifetime.current.signal.aborted) setBusy(false) }
  }
  async function deviceAction(action: DeviceAction, target?: Device) {
    if (!state) return
    const keys = local ?? await createLocalDevice(userId, crypto.randomUUID())
    setLocal(keys)
    const actor = await deviceIdentity(userId, keys.deviceId, keys.keys.publicKey, keys.signingKeys.publicKey)
    const intended = target?.identity ?? actor
    if (action === 'approve' && fingerprint.trim() !== await identityFingerprint(intended)) throw new Error('새 기기에서 확인한 지문이 일치하지 않아요.')
    const wire = await call('/security/devices/challenge', action === 'register' || action === 'recover'
      ? { action, identity: actor } : { action, actorId: actor.deviceId, targetId: intended.deviceId }) as EncryptedDeviceChallenge
    const expected = { ...wire.challenge, action, actor, target: intended, sessionHash: state.sessionHash }
    const proof = await answerDeviceChallenge(wire, expected, keys.keys, keys.signingKeys.privateKey)
    await call('/security/devices/complete', { id: wire.challenge.id, proof })
    setSelection(null); setFingerprint('')
  }

  return <section className="pro-organizations pro-security" aria-labelledby="security-title" aria-busy={locked}>
    <h2 id="security-title">본인 확인과 내 기기</h2>
    {error && <Notice error>{error}</Notice>}
    {message && <p role="status">{message}</p>}
    {busy && <p role="status">보안 설정을 확인하고 있어요.</p>}
    <button type="button" className="button" disabled={locked} onClick={() => { void run(async () => {}) }}>보안 상태 다시 조회</button>
    {state && <>
      <fieldset className="plain-fieldset" disabled={locked}>
        <legend>본인 확인</legend>
        <p>인증 수단 추가·삭제나 기기 승인·회수 전에 등록한 패스키 또는 인증 앱으로 확인해주세요. 확인은 현재 로그인에서 15분간 유효해요.</p>
        {state.reauthenticatedUntil > Date.now() && <p>본인 확인 완료 · {new Date(state.reauthenticatedUntil).toLocaleTimeString()}까지</p>}
        {state.passkeys.length > 0 && <button className="button" type="button" onClick={() => { void run(async () => {
          const { id, options } = await call('/security/reauth/options', {})
          const response = await startAuthentication({ optionsJSON: options })
          await call('/security/reauth/verify', { id, response })
        }, '패스키로 본인 확인을 마쳤어요.') }}>패스키로 본인 확인</button>}
        {state.totp && <form className="pro-form" onSubmit={event => { event.preventDefault(); void run(async () => {
          await call('/security/totp/verify', { code }); setCode('')
        }, '인증 앱으로 본인 확인을 마쳤어요.') }}>
          <label htmlFor="reauth-code">인증 앱의 6자리 코드</label>
          <input id="reauth-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={event => setCode(event.target.value)} />
          <button className="button" type="submit">코드로 본인 확인</button>
        </form>}
        {!state.totp && !state.passkeys.length && <Notice>아래에서 첫 인증 수단을 등록해주세요. 첫 등록은 로그인 후 15분 안에 할 수 있어요.</Notice>}
      </fieldset>
      <fieldset className="plain-fieldset" disabled={locked}>
        <legend>인증 수단</legend>
        <p>패스키와 인증 앱을 함께 등록해두면 하나를 잃어도 다른 수단을 쓸 수 있어요. 모든 수단을 잃으면 여기서 직접 복구할 수 없어요.</p>
        {(state.passkeys.length > 0 || state.totp) && removalReason && <p id="factor-removal-reason">{removalReason}</p>}
        <ul className="pro-members">{state.passkeys.map(key => <li key={key.id}><span>패스키 · {key.label}</span><button className="button" type="button" disabled={!!removalReason} aria-describedby={removalReason ? 'factor-removal-reason' : undefined} onClick={() => {
          if (confirm(`${key.label} 패스키를 삭제할까요?`)) void run(async () => { await call('/security/passkeys/remove', { id: key.id }); setSetup(null) }, '패스키를 삭제했어요.')
        }}>삭제</button></li>)}</ul>
        <form className="pro-form" onSubmit={event => { event.preventDefault(); void run(async () => {
          const { id, options } = await call('/security/passkeys/options', { label: name })
          const response = await startRegistration({ optionsJSON: options })
          await call('/security/passkeys/verify', { id, response })
        }, '패스키를 등록했어요. 위에서 본인 확인을 진행할 수 있어요.') }}>
          <label htmlFor="passkey-name">패스키 이름</label><input id="passkey-name" value={name} maxLength={60} required onChange={event => setName(event.target.value)} />
          <button className="button" type="submit" disabled={state.passkeys.length >= 5}>패스키 추가</button>
        </form>
        {state.totp ? <div className="actions"><span>인증 앱 등록됨</span><button type="button" className="button" disabled={!!removalReason} aria-describedby={removalReason ? 'factor-removal-reason' : undefined} onClick={() => {
          if (confirm('등록한 인증 앱을 삭제할까요?')) void run(async () => { await call('/security/totp/remove', {}); setCode('') }, '인증 앱을 삭제했어요.')
        }}>인증 앱 삭제</button></div> : <>
          <button type="button" className="button" disabled={!state.totpAvailable} onClick={() => { void run(async () => {
            const value = await call('/security/totp/options', {})
            setSetup({ id: value.id, secret: value.secret, qr: await QRCode.toDataURL(value.uri, { width: 240, margin: 2 }), expiresAt: Date.now() + 5 * 60_000 }); setCode('')
          }) }}>인증 앱 추가</button>
          {!state.totpAvailable && <p>인증 앱을 사용하려면 서버의 암호화 키 설정이 필요해요.</p>}
        </>}
        {setup && <div className="pro-form">
          <p>인증 앱에서 QR을 스캔하거나 설정 키를 직접 입력하세요. 5분 안에 코드를 확인해야 등록돼요.</p>
          <img src={setup.qr} width="240" height="240" alt="인증 앱 등록 QR 코드. 아래 설정 키로도 등록할 수 있어요." />
          <CopyField label="인증 앱 설정 키" value={setup.secret} />
          <form className="pro-form" onSubmit={event => { event.preventDefault(); void run(async () => {
            await call('/security/totp/confirm', { id: setup.id, code }); setSetup(null); setCode('')
          }, '인증 앱을 등록했어요. 코드가 새로 바뀌면 위에서 본인 확인을 진행해주세요.') }}>
            <label htmlFor="setup-code">인증 앱의 6자리 코드</label><input id="setup-code" value={code} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required onChange={event => setCode(event.target.value)} />
            <div className="actions"><button className="button" type="submit">인증 앱 등록 확인</button><button className="button" type="button" onClick={() => { setSetup(null); setCode('') }}>취소</button></div>
          </form>
        </div>}
      </fieldset>
      <fieldset className="plain-fieldset" disabled={locked}>
        <legend>파일을 받을 내 기기</legend>
        <p>브라우저마다 별도 기기로 등록해요. 패스키는 파일을 여는 키를 복구하지 않아요. 공용 PC에서는 기기를 등록하지 마세요.</p>
        {localError && <Notice error>{localError}</Notice>}
        {!state.canRegisterDevice && <Notice>워크스페이스에 참여한 뒤 기기를 등록할 수 있어요. 참여 후 보안 상태를 다시 조회해주세요.</Notice>}
        {mine && <p>현재 브라우저: {mine.status === 'active' ? '사용 가능' : mine.status === 'pending' ? '기존 기기의 승인 대기' : '회수됨'}</p>}
        {localFingerprint && <CopyField label="이 기기의 지문 · 기존 기기에서 승인할 때 확인" value={localFingerprint} />}
        {!mine && !localError && <div className="actions">
          <button className="button" type="button" disabled={!state.canRegisterDevice} onClick={() => { void run(() => deviceAction('register'), '기기 등록 상태를 확인해주세요. 추가 기기는 기존 기기에서 승인해야 해요.') }}>이 브라우저 등록</button>
          {state.devices.length > 0 && <button className="button" type="button" disabled={!state.canRegisterDevice} onClick={() => {
            if (confirm('이전 기기를 모두 회수하고 이 브라우저를 새 기기로 등록할까요? 과거 파일의 키는 복구되지 않아요.')) void run(() => deviceAction('recover'), '이전 기기를 모두 회수하고 새 기기를 등록했어요. 상대방과 지문을 다시 확인해주세요.')
          }}>모든 기기를 잃었어요</button>}
        </div>}
        {local && <div className="actions"><button type="button" className="button" onClick={() => {
          if (confirm('이 브라우저 등록을 해제할까요? 서버의 기기를 회수하고 이 브라우저의 파일 키와 상대 기기 신뢰 기록을 삭제해요. 과거 파일은 다시 열 수 없어요.')) void run(async () => {
            if (mine && mine.status !== 'revoked') await deviceAction('revoke', mine)
            await deleteLocalDevice(userId, local.deviceId)
            setLocal(undefined); setLocalFingerprint(''); setSelection(null)
          }, '이 브라우저 등록을 해제하고 파일 키와 신뢰 기록을 삭제했어요.')
        }}>이 브라우저 등록 해제</button></div>}
        {mine?.status === 'pending' && <p>기존 기기가 없다면 본인 확인 후 이 브라우저 키를 삭제하고 ‘모든 기기를 잃었어요’를 선택해주세요.</p>}
        <ul className="pro-members">{state.devices.map(device => <li key={device.identity.deviceId}>
          <span className="security-device">{device.identity.deviceId === local?.deviceId ? '현재 기기' : '다른 기기'} · {device.status === 'active' ? '사용 가능' : device.status === 'pending' ? '승인 대기' : '회수됨'}<code>{device.identity.deviceId}</code></span>
          {mine?.status === 'active' && device.status !== 'revoked' && <div className="actions">
            {device.status === 'pending' && <button className="button" type="button" onClick={() => { setSelection({ action: 'approve', device }); setFingerprint('') }}>승인</button>}
            <button className="button" type="button" onClick={() => { setSelection({ action: 'revoke', device }); setFingerprint('') }}>회수</button>
          </div>}
        </li>)}</ul>
        {selection && <form className="pro-form" onSubmit={event => { event.preventDefault(); void run(() => deviceAction(selection.action, selection.device), selection.action === 'approve' ? '기기를 승인했어요.' : '기기를 회수했어요.') }}>
          <p>{selection.device.identity.deviceId} 기기를 {selection.action === 'approve' ? '승인' : '회수'}할까요?</p>
          {selection.action === 'approve' ? <><label htmlFor="device-fingerprint">새 기기 화면에서 확인한 지문</label><input id="device-fingerprint" value={fingerprint} autoComplete="off" spellCheck={false} required maxLength={43} onChange={event => setFingerprint(event.target.value)} /></> : <p>회수하면 이 기기로 새 파일을 받을 수 없어요. 이미 받은 파일은 원격으로 삭제할 수 없어요.</p>}
          <div className="actions"><button className="button" type="submit">{selection.action === 'approve' ? '승인 확인' : '회수 확인'}</button><button className="button" type="button" onClick={() => setSelection(null)}>취소</button></div>
        </form>}
      </fieldset>
      <fieldset className="plain-fieldset" disabled={locked}>
        <legend>계정 삭제</legend>
        <p>모든 워크스페이스 참여와 인증 수단·기기를 삭제하고 모든 로그인 세션을 종료해요. 마지막 Owner라면 팀 설정에서 Owner 이전 또는 워크스페이스 삭제가 먼저 필요해요. 다른 사람의 계정과 워크스페이스는 유지돼요.</p>
        <p>관련 전달은 즉시 차단하고 남은 암호문은 24시간 안에 삭제해요. 최소 보안 기록은 30일, 암호화된 메타데이터 백업은 최대 7일 남을 수 있어요. 복원 때도 삭제 상태를 우선 적용해요.</p>
        <form className="pro-form" onSubmit={event => { event.preventDefault(); if (deletion !== '계정 삭제') return; void run(async () => {
          await call('/auth/account/remove', {})
          let warning = ''
          try { await deleteLocalDevice(userId) } catch { warning = '계정은 삭제됐지만 이 브라우저의 키를 지우지 못했어요. 브라우저 설정에서 이 사이트의 저장 데이터를 삭제해주세요.' }
          onDeleted(warning)
        }) }}>
          <label htmlFor="delete-account">계속하려면 ‘계정 삭제’를 입력하세요.</label>
          <input id="delete-account" value={deletion} onChange={event => setDeletion(event.target.value)} autoComplete="off" required />
          <button className="button destructive" type="submit" disabled={deletion !== '계정 삭제' || state.reauthenticatedUntil <= Date.now()}>계정 영구 삭제</button>
          {state.reauthenticatedUntil <= Date.now() && <p>위에서 본인 확인을 마친 뒤 삭제할 수 있어요.</p>}
        </form>
      </fieldset>
    </>}
    {local && <div className="pro-form">
      <p>연결할 수 없다면 이 브라우저의 키와 신뢰 기록만 삭제할 수 있어요. 서버 회수는 완료되지 않으니 연결 복구 후 다른 등록 기기에서 회수하거나 모든 기기 복구를 진행해주세요.</p>
      <button type="button" className="button" disabled={busy} onClick={() => {
        if (!confirm('로컬 키만 삭제할까요? 과거 파일을 열 수 없게 돼요. 서버의 기기 회수는 완료되지 않아요.')) return
        setBusy(true); setError(''); setMessage('')
        void deleteLocalDevice(userId, local.deviceId).then(() => {
          setLocal(undefined); setLocalFingerprint(''); setSelection(null)
          setMessage('로컬 키와 신뢰 기록을 삭제했어요. 서버의 기기 회수는 완료되지 않았어요.')
        }).catch(() => setError('로컬 키를 삭제하지 못했어요. 브라우저의 사이트 저장소 설정을 확인해주세요.')).finally(() => setBusy(false))
      }}>로컬 키만 삭제</button>
    </div>}
  </section>
}

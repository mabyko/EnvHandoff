import { useEffect, useRef, useState } from 'react'
import { Download, FileText } from 'lucide-react'
import { answerDeviceChallenge, deviceIdentity, identityFingerprint } from '@envhandoff/protocol/device-proof'
import type { DeviceIdentity, EncryptedDeviceChallenge, PublicationAction, PublicationDeviceChallenge } from '@envhandoff/protocol/device-proof'
import { publicationPayloadDigest, signPublicationStatement } from '@envhandoff/protocol/environment-files'
import type { EnvironmentFilesInfo, EnvironmentVersion, PublicationRecipient, PublicationStatement, PublicationWrapInput } from '@envhandoff/protocol/environment-files'
import { betaClosedMessage, ProRequestError, reservationRejected, subscribeTabReturn, uploadEncrypted } from '../lib/pro-feedback.ts'
import { proRequest } from '../lib/pro-api.ts'
import { followProLink, proPath } from '../lib/pro-navigation.ts'
import type { ProRoute } from '../lib/pro-navigation.ts'
import { loadLocalDevice, pinPeerIdentity, trustedPeerEncryptionKey } from '../lib/device-keys.ts'
import type { LocalDevice } from '../lib/device-keys.ts'
import { assertStatement, openEnvironmentBundle, planDraft, sameIdentity, sealEnvironmentBundle, unwrapEnvironmentKey, upstreamChanges, wrapEnvironmentKey } from '../lib/environment-keys.ts'
import type { DraftOp } from '../lib/environment-keys.ts'
import { explainError as bundleError, openBundle } from '../lib/bundle.ts'
import type { BundleFile, SourceFile } from '../lib/bundle.ts'
import { downloadFile, formatSize, formatTime } from '../lib/files.ts'
import { useWorkLoss } from '../lib/work-loss.ts'
import { CopyField, Notice } from './ui.tsx'

const explainError = (error: unknown) => error instanceof Error && error.name === 'Error' ? error.message : bundleError(error)
const errors: Record<string, string> = {
  beta_closed: betaClosedMessage,
  version_conflict: '다른 게시나 삭제가 먼저 확정됐어요. 변경 작업은 그대로 있어요. 최신 게시본을 다시 열고 검토한 뒤 확정해주세요.',
  grant_exists: '이 기기에는 이미 다른 접근이 제공됐어요. 상태를 새로 확인해주세요.',
  device_required: '이 브라우저 기기를 등록하고 승인받아야 해요.',
  file_permission_required: '파일 권한이 바뀌었어요. 상태를 새로 확인해주세요.',
  environment_not_found: '환경을 찾을 수 없거나 접근 권한이 없어요.',
  publication_unavailable: '게시본이 종료됐거나 바뀌었어요. 상태를 새로 확인해주세요.',
  invalid_proof: '기기 확인에 실패했어요. 상태를 새로 확인해주세요.',
  storage_limit: '워크스페이스 저장 용량 또는 동시 업로드 한도에 도달했어요.',
  download_limit: '다운로드 한도에 도달했어요. 잠시 후 다시 시도해주세요.',
  storage_unavailable: '파일 저장소가 아직 준비되지 않았어요.',
  upload_unavailable: '이 게시 시도는 종료됐어요. 상태를 확인한 뒤 다시 확정해주세요.',
}
const accessMessages = {
  empty: '아직 게시된 파일이 없어요.',
  needs_grant: '이 기기용 키 접근이 아직 없어요. 접근을 제공할 수 있는 팀원에게 아래 기기 지문을 전달해주세요.',
  no_device: '이 브라우저 기기를 등록하고 승인받은 뒤 파일을 받을 수 있어요.',
} as const
type Self = { local: LocalDevice; identity: DeviceIdentity; fingerprint: string }
type Opened = { statement: EnvironmentVersion; generation: string; files: BundleFile[] }
type Base = { generation: string; versionId?: string; files: BundleFile[] }
type Pending = { versionId: string; statement: PublicationStatement; bytes: ArrayBuffer; wraps: PublicationWrapInput[]; files: BundleFile[] }
type Props = {
  api: string; orgId: string; projectId: string; environmentId: string; project: string; environment: string; userId: string; csrf: string
  acceptNewTransfers: boolean; disabled: boolean; onExpired: () => void; onNavigate: (route: ProRoute) => void
  onExternalShare: (files: SourceFile[], environmentId: string) => void
}
const fileName = (path: string) => path.split('/').at(-1)!
const kindLabels = { keep: '유지', new: '새 파일', replace: '기존 경로 교체', delete: '삭제' } as const

// Parent keys this screen by account, session, organization and environment; unmount discards all keys and files.
export function ProEnvironment({ api, orgId, projectId, environmentId, project, environment, userId, csrf, acceptNewTransfers, disabled, onExpired, onNavigate, onExternalShare }: Props) {
  const [info, setInfo] = useState<EnvironmentFilesInfo | null>(null), [self, setSelf] = useState<Self | null>(null)
  const [pinned, setPinned] = useState<string[]>([]), [fingerprints, setFingerprints] = useState<Record<string, string>>({})
  const [opened, setOpened] = useState<Opened | null>(null), [base, setBase] = useState<Base | null>(null)
  const [ops, setOps] = useState<DraftOp[]>([]), [conflict, setConflict] = useState<{ previous: BundleFile[]; changed?: string[] } | null>(null), [reviewed, setReviewed] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null), [progress, setProgress] = useState(0)
  const [selected, setSelected] = useState<string[]>([]), [confirmClear, setConfirmClear] = useState(false)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false), [operation, setOperation] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('')
  const lifetime = useRef<AbortController | null>(null), work = useRef<AbortController | null>(null), cancelIds = useRef(new Map<string, string>())
  const state = useRef({ base, ops, opened }); state.current = { base, ops, opened }
  const conflictRef = useRef(conflict); conflictRef.current = conflict
  const root = `/organizations/${orgId}/environments/${environmentId}/files`
  const scope = { organizationId: orgId, projectId, environmentId }
  useWorkLoss(!!ops.length || !!pending || !!opened)

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller
    void run(inspect, '환경 파일 상태 확인 중…')
    const stop = subscribeTabReturn(() => { if (!work.current) void run(inspect, '환경 파일 상태 확인 중…') })
    return () => { stop(); controller.abort(); work.current?.abort(); work.current = null }
    // Keyed by the parent; rerenders must not discard in-memory drafts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const call = (path: string, body: Record<string, unknown> | undefined, signal: AbortSignal) => proRequest(api + root + path, { csrf, signal, body, errors, onExpired })
  async function run(action: (signal: AbortSignal) => Promise<unknown>, label: string) {
    if (work.current || !lifetime.current || lifetime.current.signal.aborted) return
    const controller = new AbortController(); work.current = controller
    setBusy(true); setOperation(label); setError(''); setMessage('')
    const signal = AbortSignal.any([controller.signal, lifetime.current.signal])
    try { await action(signal) } catch (e) { if (!signal.aborted) setError(explainError(e)) }
    finally { if (work.current === controller) { work.current = null; if (!lifetime.current?.signal.aborted) setBusy(false) } }
  }

  async function device(): Promise<Self> {
    const local = await loadLocalDevice(userId)
    if (!local) throw new Error(accessMessages.no_device)
    const identity = await deviceIdentity(userId, local.deviceId, local.keys.publicKey, local.signingKeys.publicKey)
    return { local, identity, fingerprint: await identityFingerprint(identity) }
  }
  async function isPinned(identity: DeviceIdentity) {
    try { await trustedPeerEncryptionKey(userId, identity); return true } catch { return false }
  }
  async function inspect(signal: AbortSignal): Promise<EnvironmentFilesInfo> {
    let mine: Self | null = null
    try { mine = await device() } catch { /* access reports no_device */ }
    const value: EnvironmentFilesInfo = await (await call(mine ? `?device=${mine.identity.deviceId}` : '', undefined, signal)).json()
    const identities = [value.latest?.publisher, value.wrap?.wrapper, ...value.recipients.map(item => item.identity)].filter((item): item is DeviceIdentity => !!item)
    const trusted: string[] = []
    for (const identity of identities) if (await isPinned(identity)) trusted.push(identity.userId + identity.deviceId)
    signal.throwIfAborted()
    setSelf(mine); setInfo(value); setPinned(trusted)
    const current = state.current
    if (current.base && current.base.generation !== value.generation) {
      setOpened(null); setSelected([])
      if (current.ops.length) { setConflict(old => old ?? { previous: current.base!.files }); setReviewed(false) }
      else setBase(null)
    }
    if (!value.latest && (!current.base || current.base.generation !== value.generation) && !current.ops.length) setBase({ generation: value.generation, files: [] })
    return value
  }
  const trustedIdentity = (identity?: DeviceIdentity) => !!identity && (sameIdentity(identity, self?.identity) || pinned.includes(identity.userId + identity.deviceId))

  async function prove(action: PublicationAction, version: { versionId: string; generation: string; digest: string }, payloadDigest: string, mine: Self, target: DeviceIdentity, sessionHash: string, signal: AbortSignal) {
    const wire: EncryptedDeviceChallenge<PublicationDeviceChallenge> = await (await call(`/versions/${version.versionId}/challenge`, {
      action, deviceId: mine.identity.deviceId, ...(action === 'publication-grant' ? { targetDeviceId: target.deviceId } : {}), payloadDigest,
    }, signal)).json()
    const expected: PublicationDeviceChallenge = {
      id: wire.challenge.id, issuedAt: wire.challenge.issuedAt, expiresAt: wire.challenge.expiresAt, action, actor: mine.identity, target, sessionHash,
      scope: { ...scope, versionId: version.versionId, generation: version.generation, digest: version.digest, targetDeviceId: target.deviceId, payloadDigest },
    }
    return { id: wire.challenge.id, proof: await answerDeviceChallenge(wire, expected, mine.local.keys, mine.local.signingKeys.privateKey) }
  }

  // Verifies statement, own wrap and wrapper trust; returns the ephemeral code for this action only.
  async function ownCode(value: EnvironmentFilesInfo, mine: Self) {
    const latest = value.latest, wrap = value.wrap
    if (!latest || latest.status !== 'committed') throw new Error(accessMessages.empty)
    if (value.access !== 'available' || !wrap) throw new Error(accessMessages[value.access === 'available' ? 'needs_grant' : value.access])
    await assertStatement(latest, scope)
    if (!sameIdentity(wrap.recipient, mine.identity)) throw new Error('키 접근이 이 브라우저의 등록 기기와 달라요. 기기 등록 상태를 확인해주세요.')
    const wrapperKey = sameIdentity(wrap.wrapper, mine.identity) ? mine.local.keys.publicKey
      : await trustedPeerEncryptionKey(userId, wrap.wrapper).catch(() => { throw new Error('키 접근을 제공한 기기의 지문을 먼저 확인해주세요.') })
    return unwrapEnvironmentKey(wrap.wrap, latest, wrap.wrapper, wrapperKey, mine.identity, mine.local.keys)
  }

  async function openLatest(signal: AbortSignal) {
    const mine = await device(), value = await inspect(signal), latest = value.latest
    if (!latest) {
      const previous = state.current
      setOpened(null); setSelected([]); setBase({ generation: value.generation, files: [] })
      if (previous.ops.length) {
        const files = conflictRef.current?.previous ?? previous.base?.files ?? []
        setConflict({ previous: files, changed: upstreamChanges(files, [], previous.ops) }); setReviewed(false)
      }
      return
    }
    const code = await ownCode(value, mine)
    const version = { versionId: latest.versionId, generation: value.generation, digest: latest.digest }
    const response = await call(`/versions/${latest.versionId}/download`, { deviceId: mine.identity.deviceId,
      ...await prove('publication-download', version, await publicationPayloadDigest('publication-download'), mine, mine.identity, value.sessionHash, signal) }, signal)
    const reader = response.body!.getReader(), chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { value: chunk, done } = await reader.read()
        if (done) break
        size += chunk.byteLength
        if (size > latest.size) throw new Error('게시본 크기가 서명과 달라요.')
        chunks.push(chunk)
      }
    } finally { await reader.cancel(); reader.releaseLock() }
    const bytes = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const bundle = await openEnvironmentBundle(bytes.buffer, latest, scope, code)
    signal.throwIfAborted()
    const previous = state.current
    setOpened({ statement: latest, generation: value.generation, files: bundle.files }); setSelected([])
    setBase({ generation: value.generation, versionId: latest.versionId, files: bundle.files })
    if (previous.ops.length && (conflictRef.current || (previous.base && previous.base.generation !== value.generation))) {
      setConflict({ previous: conflictRef.current?.previous ?? previous.base?.files ?? [], changed: upstreamChanges(conflictRef.current?.previous ?? previous.base?.files ?? [], bundle.files, previous.ops) })
      setReviewed(false)
    }
  }

  async function publish(signal: AbortSignal) {
    if (!acceptNewTransfers) throw new Error(betaClosedMessage)
    const mine = await device()
    let upload = pending
    if (!upload) {
      const value = info!, draft = base!
      if (!value.permissions.send || !value.permissions.receive) throw new Error('게시하려면 이 환경의 받기·보내기 권한이 모두 필요해요.')
      const { sources } = planDraft(draft.files, ops)
      if (!sources.length) throw new Error('남은 파일이 없어요. 모든 파일 비우기를 사용해주세요.')
      const sealed = await sealEnvironmentBundle(sources, project, environment)
      const files = (await openBundle(sealed.bytes, sealed.code)).files
      const versionId = crypto.randomUUID()
      const statement = await signPublicationStatement({ ...scope, versionId, expectedGeneration: draft.generation, size: sealed.size, digest: sealed.digest, publisher: mine.identity }, mine.local.signingKeys.privateKey)
      const wraps: PublicationWrapInput[] = [{ recipientDeviceId: mine.identity.deviceId, wrap: await wrapEnvironmentKey(sealed.code, statement, mine.identity, mine.local.keys, mine.identity, mine.local.keys.publicKey) }]
      for (const recipient of value.recipients) {
        if (sameIdentity(recipient.identity, mine.identity) || !trustedIdentity(recipient.identity)) continue
        wraps.push({ recipientDeviceId: recipient.identity.deviceId, wrap: await wrapEnvironmentKey(sealed.code, statement, mine.identity, mine.local.keys, recipient.identity, await trustedPeerEncryptionKey(userId, recipient.identity)) })
      }
      upload = { versionId, statement, bytes: sealed.bytes, wraps, files }
      signal.throwIfAborted(); setPending(upload)
    }
    let reserved: EnvironmentVersion
    try {
      reserved = await (await call('/versions', { operationId: upload.versionId, deviceId: mine.identity.deviceId, expectedGeneration: upload.statement.expectedGeneration,
        size: upload.statement.size, digest: upload.statement.digest, signature: upload.statement.signature, wraps: upload.wraps }, signal)).json()
    } catch (e) {
      if (!signal.aborted && reservationRejected(e)) setPending(null)
      if (e instanceof ProRequestError && e.code === 'version_conflict' && !signal.aborted) { setConflict(old => old ?? { previous: base?.files ?? [] }); setReviewed(false) }
      throw e
    }
    signal.throwIfAborted()
    if (reserved.status === 'reserved') {
      const sessionHash = info!.sessionHash
      const payloadDigest = await publicationPayloadDigest('publication-upload', { signature: upload.statement.signature, wraps: upload.wraps })
      const proof = await prove('publication-upload', { versionId: upload.versionId, generation: upload.statement.expectedGeneration, digest: upload.statement.digest }, payloadDigest, mine, mine.identity, sessionHash, signal)
      setProgress(0)
      try { await uploadEncrypted(api + root + `/versions/${upload.versionId}/content`, upload.bytes, { 'x-csrf-token': csrf, 'x-device-challenge': proof.id, 'x-device-proof': proof.proof }, signal, setProgress) }
      catch (e) { if (e instanceof Error && e.name === 'SessionExpired') onExpired(); throw e }
    } else if (['failed', 'cancelled'].includes(reserved.status)) return settleEnded()
    else if (reserved.status !== 'committed') return void await checkResult(upload, signal)
    await finishPublish(upload, signal)
  }
  async function finishPublish(upload: Pending, signal: AbortSignal) {
    const value = await inspect(signal)
    if (value.latest?.versionId !== upload.versionId) {
      setPending(null); setProgress(0); setOpened(null); setSelected([])
      setConflict(old => old ?? { previous: state.current.base?.files ?? [] }); setReviewed(false)
      setMessage('게시 시도는 완료됐지만 이후 다른 게시나 삭제가 확정됐어요. 변경 작업은 남아 있어요. 최신 상태를 확인하고 다시 검토해주세요.')
      return
    }
    setPending(null); setOps([]); setConflict(null); setReviewed(false); setProgress(0); setSelected([]); setEditing(false)
    setOpened({ statement: value.latest, generation: value.generation, files: upload.files })
    setBase({ generation: value.generation, versionId: upload.versionId, files: upload.files })
    setMessage('팀에 게시했어요. 접근을 제공한 기기에서 최신 파일을 받을 수 있어요.')
  }
  async function checkResult(upload: Pending, signal: AbortSignal) {
    const result: { version: EnvironmentVersion } = await (await call(`/versions/${upload.versionId}`, undefined, signal)).json()
    signal.throwIfAborted()
    if (result.version.status === 'committed') return finishPublish(upload, signal)
    if (['failed', 'cancelled'].includes(result.version.status)) return settleEnded()
    setMessage(result.version.status === 'writing' ? '서버가 파일을 저장하고 있어요. 잠시 후 결과를 다시 확인해주세요.' : '게시 대기 중이에요. 같은 시도를 다시 보낼 수 있어요.')
  }
  function settleEnded() {
    setPending(null); setProgress(0); setMessage('이전 게시 시도는 종료됐어요. 변경 작업은 남아 있어요. 다시 확정할 수 있어요.')
  }
  async function cancelUpload() {
    if (!pending) return
    work.current?.abort(); work.current = null
    const upload = pending
    await run(async signal => {
      const operationId = cancelIds.current.get(upload.versionId) ?? crypto.randomUUID(); cancelIds.current.set(upload.versionId, operationId)
      const result: { status: EnvironmentVersion['status'] } = await (await call(`/versions/${upload.versionId}/cancel`, { operationId }, signal)).json()
      cancelIds.current.delete(upload.versionId)
      if (['failed', 'cancelled'].includes(result.status)) return settleEnded()
      await checkResult(upload, signal)
    }, '게시 취소 확인 중…')
  }

  async function clearAll(signal: AbortSignal) {
    const mine = await device(), value = await inspect(signal), latest = value.latest
    if (!latest || !base || value.generation !== base.generation) throw new Error('최신 게시본이 바뀌었어요. 다시 열고 확인해주세요.')
    const version = { versionId: latest.versionId, generation: base.generation, digest: latest.digest }
    await call(`/versions/${latest.versionId}/remove`, { deviceId: mine.identity.deviceId, expectedGeneration: base.generation,
      ...await prove('publication-remove', version, await publicationPayloadDigest('publication-remove'), mine, mine.identity, value.sessionHash, signal) }, signal)
    setOps([]); setOpened(null); setBase(null); setConfirmClear(false); setConflict(null); setSelected([])
    state.current = { base: null, ops: [], opened: null } // The head changed by our own confirmed removal, not a conflict.
    await inspect(signal)
    setMessage('환경의 게시 파일을 모두 비웠어요. 이미 내려받은 파일은 원격으로 삭제되지 않아요.')
  }

  async function grant(recipient: PublicationRecipient, signal: AbortSignal) {
    if (!acceptNewTransfers) throw new Error(betaClosedMessage)
    const mine = await device(), value = await inspect(signal), latest = value.latest
    if (!latest || !value.permissions.send || !value.permissions.receive) throw new Error('접근을 제공하려면 받기·보내기 권한과 최신 게시본이 필요해요.')
    const target = value.recipients.find(item => sameIdentity(item.identity, recipient.identity))
    if (!target || target.hasWrap) throw new Error('수신 기기 상태가 바뀌었어요. 목록을 확인해주세요.')
    const key = await trustedPeerEncryptionKey(userId, target.identity)
    const wrap = await wrapEnvironmentKey(await ownCode(value, mine), latest, mine.identity, mine.local.keys, target.identity, key)
    const version = { versionId: latest.versionId, generation: value.generation, digest: latest.digest }
    const payloadDigest = await publicationPayloadDigest('publication-grant', { targetDeviceId: target.identity.deviceId, wrap })
    await call(`/versions/${latest.versionId}/grants`, { deviceId: mine.identity.deviceId, targetDeviceId: target.identity.deviceId, wrap,
      ...await prove('publication-grant', version, payloadDigest, mine, target.identity, value.sessionHash, signal) }, signal)
    await inspect(signal)
    setMessage(`${target.login}의 기기에 파일 접근을 제공했어요.`)
  }
  async function pin(identity: DeviceIdentity, signal: AbortSignal) {
    const id = identity.userId + identity.deviceId
    await pinPeerIdentity(userId, identity, (fingerprints[id] ?? '').trim())
    signal.throwIfAborted()
    setFingerprints(current => ({ ...current, [id]: '' })); await inspect(signal)
    setMessage('기기 지문을 확인하고 이 브라우저에 저장했어요.')
  }

  function addFiles(list: FileList | null) {
    const chosen = Array.from(list ?? [])
    setOps(current => [...current, ...chosen.map(file => {
      const matches = (base?.files ?? []).filter(item => fileName(item.path) === file.name)
      return { file, path: matches.length === 1 ? matches[0].path : file.name }
    })])
    setReviewed(false)
  }
  const external = (paths: string[]) => {
    if (!opened) return
    onExternalShare(opened.files.filter(file => paths.includes(file.path)).map(file => ({ path: file.path, file: new File([file.bytes], fileName(file.path)) })), environmentId)
  }

  let plan: ReturnType<typeof planDraft> | null = null, planError = ''
  if (base && ops.length) { try { plan = planDraft(base.files, ops) } catch (e) { planError = bundleError(e) } }
  const permissions = info?.permissions, canPublish = !!permissions?.send && !!permissions.receive
  const latest = info?.latest, others = (info?.recipients ?? []).filter(item => !sameIdentity(item.identity, self?.identity))
  const unpinned = others.filter(item => !trustedIdentity(item.identity)).length
  const needsReview = !!conflict && (!conflict.changed || !reviewed)
  const locked = busy || disabled
  const settings: ProRoute = { page: 'settings', orgId }
  const pinForm = (identity: DeviceIdentity, label: string) => {
    const id = identity.userId + identity.deviceId
    return <form className="pro-form" aria-label={`${label} 지문 확인`} onSubmit={event => { event.preventDefault(); void run(signal => pin(identity, signal), '기기 지문 확인 중…') }}>
      <label>{label} · 별도 대화로 받은 기기 지문<input value={fingerprints[id] ?? ''} onChange={event => setFingerprints(current => ({ ...current, [id]: event.target.value }))} required maxLength={43} autoComplete="off" spellCheck={false} /></label>
      <p className="help">기기 <code>{identity.deviceId}</code>의 화면에 표시된 지문을 알고 있는 연락 경로로 받아 입력하세요.</p>
      <button className="button" type="submit">지문 대조 후 저장</button>
    </form>
  }

  return <section className="pro-environment-files" aria-label={`${environment} 환경 파일`} aria-busy={locked} data-work-loss={!!ops.length || !!pending || !!opened}>
    {!acceptNewTransfers && <Notice>{betaClosedMessage} 이미 게시된 파일은 계속 받을 수 있어요. 게시·접근 제공·외부 공유는 재개 후 가능해요.</Notice>}
    {error && <Notice error>{error}</Notice>}
    <p className="pro-operation-status" role="status">{busy ? operation : message}</p>
    {busy && operation === '암호화·게시 처리 중…' && progress > 0 && <progress max={100} value={progress} aria-label="게시 업로드 진행률" />}
    {info?.endReason === 'publisher_erased' && !latest && <Notice>게시자 계정이 영구 삭제돼 최신 게시본이 종료됐어요. 원본을 가진 권한자가 새 키로 다시 게시해주세요.</Notice>}
    {info && !info.latest && info.endReason && info.endReason !== 'publisher_erased' && <Notice>최신 게시본이 종료됐어요. 다시 게시해야 받을 수 있어요.</Notice>}

    <fieldset className="plain-fieldset" disabled={locked}>
      <legend className="sr-only">최신 파일</legend>
      <div className="pro-section-header"><h3>환경 파일 {opened && <span className="pro-meta">{opened.files.length}개</span>}</h3><div className="actions"><button className="button" type="button" onClick={() => { void run(inspect, '환경 파일 상태 확인 중…') }}>상태 새로고침</button>{canPublish && latest && base && <button className="button primary" type="button" disabled={!acceptNewTransfers} onClick={() => setEditing(true)}>파일 변경</button>}</div></div>
      <p className="pro-published-meta">{latest ? `${latest.publisherLogin} · ${formatTime(latest.publishedAt ?? latest.createdAt)} 게시 · ${formatSize(latest.size)}` : '팀에 게시한 파일을 이곳에서 받을 수 있어요.'}</p>
      {latest && opened && <p className="pro-verified-summary">{sameIdentity(latest.publisher, self?.identity) ? '이 기기에서 게시했어요.' : trustedIdentity(latest.publisher) ? '지문을 확인한 기기의 서명을 확인했어요.' : '게시자 서명은 확인했지만 게시자 기기 지문은 직접 확인하지 않았어요. 지문을 확인한 기기가 제공한 접근으로 열었어요.'}</p>}
      {latest && !latest.publisherActive && <Notice>게시자가 더 이상 이 환경의 활성 게시자가 아니에요. 파일은 계속 받을 수 있지만 새 키로 다시 게시하는 것을 권장해요.</Notice>}
      {info?.wrap && !info.wrap.wrapperActive && <Notice>이 기기에 접근을 제공한 기기가 회수됐어요. 이미 받은 접근으로 계속 열 수 있지만 새 키로 다시 게시하는 것을 권장해요.</Notice>}
      {info && info.access !== 'available' && <div className="pro-empty-state"><h4>{info.access === 'empty' ? '아직 게시된 파일이 없어요' : info.access === 'no_device' ? '파일을 받을 기기를 등록하세요' : '이 기기의 파일 접근이 필요해요'}</h4><p>{info.access === 'empty' ? canPublish ? '파일을 추가하고 저장소 안에서 넣을 경로를 확인한 뒤 게시하세요.' : '팀원이 파일을 게시하면 여기서 확인할 수 있어요.' : accessMessages[info.access]}</p>{info.access === 'empty' && canPublish && base && <button className="button primary" type="button" disabled={!acceptNewTransfers} onClick={() => setEditing(true)}>첫 파일 추가</button>}</div>}
      {info?.access === 'no_device' && <a className="text-button" href={proPath(settings)} onClick={event => followProLink(event, settings, onNavigate)}>내 기기 등록·관리</a>}
      {info?.access === 'needs_grant' && self && <CopyField label="접근을 요청할 때 보낼 내 기기 지문" value={self.fingerprint} />}
      {info?.wrap && self && !trustedIdentity(info.wrap.wrapper) && pinForm(info.wrap.wrapper, '접근을 제공한 기기')}
      {info?.access === 'available' && latest && (!opened || opened.statement.versionId !== latest.versionId) && <button className="button primary" type="button" disabled={!!info.wrap && !trustedIdentity(info.wrap.wrapper)} onClick={() => { void run(openLatest, '최신 파일 받는 중…') }}>최신 파일 열기</button>}
      {opened && <>
        <p className="help">표시된 경로에 파일을 넣으세요. Git 저장소 루트 기준이며, 기존 파일을 덮어쓰기 전에 내용을 확인하세요.</p>
        {permissions?.externalShare && <p className="pro-selection-help">여러 파일을 링크로 공유하려면 왼쪽 체크박스로 선택하세요.</p>}
        <ul className="pro-env-files pro-file-table">{opened.files.map(file => <li key={file.path}>
          {permissions?.externalShare && <label className="pro-file-check"><input type="checkbox" aria-label={`${file.path} 외부 공유에 포함`} checked={selected.includes(file.path)} onChange={event => setSelected(current => event.target.checked ? [...current, file.path] : current.filter(path => path !== file.path))} /></label>}
          <span className="pro-file-icon" aria-hidden="true"><FileText /></span><span className="pro-file-name"><code>{file.path}</code><small>{formatSize(file.bytes.byteLength)} · 다운로드 이름 {fileName(file.path)}</small></span>
          <div className="actions">
            <button className="button" type="button" onClick={() => downloadFile(file.bytes.slice().buffer, fileName(file.path))}><Download aria-hidden="true" />다운로드</button>
            {permissions?.externalShare && <button className="button" type="button" disabled={!acceptNewTransfers} onClick={() => external([file.path])}>이 파일 외부 공유</button>}
            {canPublish && base?.versionId === opened.statement.versionId && !ops.some(op => op.path === file.path) && <button className="text-button" type="button" onClick={() => { setEditing(true); setOps(current => [...current, { path: file.path }]) }}>삭제 항목에 추가</button>}
          </div>
        </li>)}</ul>
        {permissions?.externalShare && selected.length > 0 && <button className="button" type="button" disabled={!acceptNewTransfers} onClick={() => external(selected)}>선택한 {selected.length}개 외부 공유</button>}
      </>}
    </fieldset>

    {canPublish && <details className="pro-editor pro-settings-section" open={editing || !!ops.length || !!pending || !!conflict} onToggle={event => setEditing(event.currentTarget.open)}><summary>파일 추가·교체·삭제 후 게시</summary><fieldset className="plain-fieldset" disabled={locked}>
      <legend className="sr-only">파일 추가·교체·삭제 후 게시</legend>
      <p className="help">파일과 배치 경로를 확인하세요. 게시하기 전까지 팀의 최신 파일은 바뀌지 않아요.</p>
      {!base && latest && <p>변경 전에 최신 파일을 열어야 해요. 변경하지 않은 파일은 원본 그대로 다시 게시돼요.</p>}
      {base && <>
        <label className="pro-form pro-file-picker">추가하거나 교체할 파일<input type="file" multiple disabled={!!pending} onChange={event => { addFiles(event.target.files); event.target.value = '' }} /></label>
        {ops.map((op, index) => <div className="pro-form pro-env-op" key={index}>
          {op.file ? <label>저장소 루트 기준 배치 경로 · {op.file.name}<input value={op.path} disabled={!!pending} autoComplete="off" spellCheck={false} onChange={event => { setReviewed(false); setOps(current => current.map((item, i) => i === index ? { ...item, path: event.target.value } : item)) }} /></label>
            : <p><code>{op.path}</code> 삭제 예정</p>}
          {op.file && <p className="help">{base.files.some(file => file.path === op.path) ? '기존 경로 교체' : '새 파일'} · 저장소 루트/<code>{op.path}</code></p>}
          <button className="text-button" type="button" disabled={!!pending} onClick={() => { setReviewed(false); setOps(current => current.filter((_, i) => i !== index)) }}>변경 취소</button>
        </div>)}
        {planError && <Notice error>{planError}</Notice>}
        {plan && <section className="pro-publication-review"><h4>게시할 결과</h4><ul className="pro-env-plan" aria-label="게시할 결과">{plan.rows.map(row => <li key={row.path}><code>{row.path}</code> · {kindLabels[row.kind]} · {formatSize(row.size)}</li>)}</ul></section>}
        {conflict && <Notice error>다른 게시나 삭제가 먼저 확정됐어요. 변경 작업은 그대로 있어요.{!conflict.changed ? ' 최신 게시본을 다시 열어 확인해주세요.' : conflict.changed.length ? ` 내가 변경한 경로 중 다른 사람이 바꾼 파일: ${conflict.changed.join(', ')}` : ' 내가 변경한 경로는 다른 사람이 바꾸지 않았어요.'}</Notice>}
        {conflict && !conflict.changed && (latest ? <button className="button" type="button" onClick={() => { void run(openLatest, '최신 파일 받는 중…') }}>최신 게시본 다시 열기</button>
          : <button className="button" type="button" onClick={() => { void run(async signal => { const value = await inspect(signal); setBase({ generation: value.generation, files: [] }); setConflict({ previous: conflict.previous, changed: upstreamChanges(conflict.previous, [], ops) }) }, '상태 확인 중…') }}>최신 상태 다시 확인</button>)}
        {conflict?.changed && <label className="pro-check"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />최신 게시본 기준으로 결과를 검토했어요</label>}
        {ops.length > 0 && <>
          <p className="help">현재 키 접근 대상: 이 기기와 지문을 확인한 기기 {others.length - unpinned}개.{unpinned > 0 && ` ${unpinned}개 기기는 이 게시본에 접근하지 못해요. 게시 후 아래에서 지문을 확인하고 접근을 제공할 수 있어요.`}</p>
          <p className="help">서버에는 파일 이름·배치 경로·내용·키가 전달되지 않아요.</p>
          {plan && !plan.sources.length
            ? <button className="button destructive" type="button" disabled={needsReview} onClick={() => setConfirmClear(true)}>모든 파일 비우기</button>
            : <button className="button primary" type="button" disabled={!acceptNewTransfers || !plan || needsReview} onClick={() => { void run(publish, '암호화·게시 처리 중…') }}>{pending ? '같은 게시 재시도' : '팀에 게시'}</button>}
          {!pending && <button className="button" type="button" onClick={() => { setOps([]); setConflict(null); setReviewed(false) }}>변경 작업 모두 취소</button>}
        </>}
        {!ops.length && !!base.files.length && <button className="text-button" type="button" onClick={() => setConfirmClear(true)}>모든 파일 비우기</button>}
        {confirmClear && <div className="pro-form"><p>이 환경의 게시 파일을 모두 비울까요? 환경 설정은 유지돼요. 이미 내려받은 파일은 원격으로 삭제되지 않아요.</p>
          <div className="actions"><button className="button destructive" type="button" onClick={() => { void run(clearAll, '게시 파일 비우는 중…') }}>비우기 확인</button><button className="button" type="button" onClick={() => setConfirmClear(false)}>취소</button></div></div>}
        {pending && <div className="actions"><button className="button" type="button" onClick={() => { void run(signal => checkResult(pending, signal), '게시 결과 확인 중…') }}>결과 확인</button></div>}
      </>}
    </fieldset></details>}
    {pending && <button className="button destructive" type="button" disabled={disabled} onClick={() => { void cancelUpload() }}>게시 중단 — 변경 작업 유지</button>}

    {canPublish && latest && others.length > 0 && <details className="pro-settings-section pro-access-section">
      <summary>파일 접근 준비 · 접근 없는 기기 {others.filter(item => !item.hasWrap).length}개</summary>
      <p>받기 권한이 있는 활성 기기예요. 지문을 별도 대화로 확인한 기기에만 이 게시본의 키를 제공할 수 있어요. Owner 권한도 키 접근을 대신하지 않아요.</p>
      {self && <CopyField label="상대에게 보낼 내 기기 지문" value={self.fingerprint} />}
      <ul className="pro-members">{others.map(item => <li key={item.identity.deviceId}>
        <span>{item.login} · <code>{item.identity.deviceId}</code> · {item.hasWrap ? '접근 있음' : trustedIdentity(item.identity) ? '지문 확인됨' : '지문 확인 필요'}</span>
        {!item.hasWrap && (trustedIdentity(item.identity)
          ? <button className="button" type="button" disabled={locked || !acceptNewTransfers || info?.access !== 'available'} onClick={() => { void run(signal => grant(item, signal), '키 접근 제공 중…') }}>{item.login}에게 접근 제공</button>
          : pinForm(item.identity, item.login))}
      </li>)}</ul>
    </details>}
    {info && !canPublish && info.permissions.receive && <p className="help">게시와 접근 제공에는 받기·보내기 권한이 모두 필요해요.</p>}
  </section>
}

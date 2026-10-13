import { randomUUID } from 'node:crypto'
import type { Database } from './database.ts'
import { Organizations } from './organizations.ts'
import { fields, HttpError, jsonBody } from './http.ts'
import { Objects } from './objects.ts'
import { limits } from './limits.ts'
import { fenceUpload, uploadCancelled } from './upload-cancellations.ts'
import { invalidatePublications } from './lifecycle.ts'
import { deviceHash, encryptDeviceChallenge, verifyDeviceProof, DEVICE_CHALLENGE_MS } from '@envhandoff/protocol/device-proof'
import type { DeviceIdentity, PublicationAction, PublicationDeviceChallenge, PublicationScope } from '@envhandoff/protocol/device-proof'
import { publicationPayloadDigest, verifyPublicationStatement, validatePublicationWrap } from '@envhandoff/protocol/environment-files'
import type { PublicationStatement, PublicationWrapInput, EnvironmentVersion, EnvironmentFilesInfo } from '@envhandoff/protocol/environment-files'

const DAY = 86_400_000
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new HttpError(400, 'invalid_input')
  return value
}
function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value
}
type Session = { user_id: string; token_hash: string }
type Head = { generation: string; version_id: string | null; end_reason: string | null }
type Version = {
  id: string; org_id: string; project_id: string; environment_id: string; publisher_user_id: string; publisher_device_id: string;
  publisher_identity: string; expected_generation: string; size: number; digest: string; signature: string;
  input_digest: string; upload_payload_digest: string; status: EnvironmentVersion['status']; created_at: number; published_at: number | null;
  write_until: number | null; ended_at: number | null; deleted_at: number | null; end_reason: string | null;
}
type Wrap = { recipient_identity: string; wrapper_identity: string; wrapper_device_id: string; wrapper_user_id: string; wrap: string }

export class Publications {
  private readonly db: Database
  private readonly organizations: Organizations
  private readonly objects?: Objects
  private readonly clock: () => number
  private readonly acceptNewTransfers: boolean
  constructor(db: Database, root?: string, clock = Date.now, acceptNewTransfers = true) {
    this.db = db; this.organizations = new Organizations(db, clock); this.clock = clock; this.acceptNewTransfers = acceptNewTransfers
    if (root) this.objects = new Objects(root)
  }
  private async current(session: () => Promise<Session>, auth: Session, org: string) {
    const current = await session()
    if (current.token_hash !== auth.token_hash || current.user_id !== auth.user_id) throw new HttpError(401, 'session_expired')
    await this.db.run('UPDATE sessions SET last_seen=$1 WHERE token_hash=$2', this.clock(), auth.token_hash)
    await invalidatePublications(this.db, this.clock(), { organizationId: org })
  }
  private async rights(auth: Session, org: string, environment: string, write = false) {
    await this.organizations.requireFilePermission(auth.user_id, org, environment, 'receive')
    if (write) await this.organizations.requireFilePermission(auth.user_id, org, environment, 'send')
    return (await this.db.get<{ project_id: string; receive: number; send: number; external_share: number }>(
      'SELECT project_id,receive,send,external_share FROM effective_file_permissions WHERE org_id=$1 AND environment_id=$2 AND user_id=$3', org, environment, auth.user_id))!
  }
  private async identity(userId: string, device: string): Promise<DeviceIdentity> {
    const row = await this.db.get<{ identity: string }>("SELECT identity FROM devices WHERE id=$1 AND user_id=$2 AND status='active'", device, userId)
    if (!row) throw new HttpError(403, 'device_required')
    return JSON.parse(row.identity)
  }
  private async recipient(org: string, environment: string, device: string): Promise<DeviceIdentity> {
    const row = await this.db.get<{ identity: string }>(`SELECT d.identity FROM devices d JOIN effective_file_permissions p ON p.user_id=d.user_id
      WHERE p.org_id=$1 AND p.environment_id=$2 AND p.receive=1 AND d.id=$3 AND d.status='active'`, org, environment, device)
    if (!row) throw new HttpError(403, 'recipient_unavailable')
    return JSON.parse(row.identity)
  }
  private async head(org: string, environment: string): Promise<Head> {
    await this.db.run('INSERT INTO environment_publication_heads(environment_id,org_id,generation) VALUES($1,$2,$3) ON CONFLICT(environment_id) DO NOTHING', environment, org, randomUUID())
    const head = await this.db.get<Head>('SELECT generation,version_id,end_reason FROM environment_publication_heads WHERE environment_id=$1 AND org_id=$2', environment, org)
    if (!head) throw new HttpError(404, 'environment_not_found')
    return head
  }
  private async version(org: string, environment: string, versionId: string): Promise<Version> {
    const row = await this.db.get<Version>('SELECT * FROM environment_versions WHERE id=$1 AND org_id=$2 AND environment_id=$3', versionId, org, environment)
    if (!row) throw new HttpError(404, 'version_unavailable')
    return row
  }
  private statement(v: Version): PublicationStatement {
    return { organizationId: v.org_id, projectId: v.project_id, environmentId: v.environment_id, versionId: v.id,
      expectedGeneration: v.expected_generation, size: v.size, digest: v.digest, publisher: JSON.parse(v.publisher_identity), signature: v.signature }
  }
  private async summary(v: Version): Promise<EnvironmentVersion> {
    if (v.publisher_identity === '{}' || !v.signature) throw new HttpError(410, 'publisher_erased')
    const publisher = await this.db.get<{ login: string; active: boolean }>(`SELECT u.login,EXISTS(SELECT 1 FROM devices d WHERE d.id=$1 AND d.user_id=u.id AND d.status='active') AS active
      FROM users u WHERE u.id=$2 AND u.disabled=0`, v.publisher_device_id, v.publisher_user_id)
    return { ...this.statement(v), status: v.status, createdAt: v.created_at, publishedAt: v.published_at, endedAt: v.ended_at,
      endReason: v.end_reason, publisherLogin: publisher?.login ?? '탈퇴한 게시자', publisherActive: !!publisher?.active }
  }
  private async ownWrap(v: Version, actor: DeviceIdentity): Promise<Wrap> {
    const wrap = await this.db.get<Wrap>('SELECT * FROM environment_key_wraps WHERE version_id=$1 AND recipient_device_id=$2 AND recipient_user_id=$3', v.id, actor.deviceId, actor.userId)
    if (!wrap || JSON.stringify(actor) !== wrap.recipient_identity) throw new HttpError(403, 'key_access_required')
    return wrap
  }
  private async latest(v: Version) {
    const head = await this.head(v.org_id, v.environment_id)
    if (head.version_id !== v.id || v.status !== 'committed' || v.ended_at !== null) throw new HttpError(410, 'version_unavailable')
    return head
  }
  private async event(actor: string, v: Version, event: string) {
    await this.db.run('INSERT INTO organization_events(org_id,actor_id,target_id,event,created_at) VALUES($1,$2,$3,$4,$5)', v.org_id, actor, v.id, event, this.clock())
  }
  private open() { if (!this.acceptNewTransfers) throw new HttpError(503, 'beta_closed') }
  private async info(auth: Session, org: string, environment: string, selected?: string): Promise<EnvironmentFilesInfo> {
    const rights = await this.rights(auth, org, environment), head = await this.head(org, environment)
    const v = head.version_id ? await this.version(org, environment, head.version_id) : undefined
    let actor: DeviceIdentity | undefined, wrap: Wrap | undefined
    if (selected) {
      // Unknown or revoked self devices get the registration state, never another user's grant.
      const row = await this.db.get<{ identity: string }>("SELECT identity FROM devices WHERE id=$1 AND user_id=$2 AND status='active'", id(selected), auth.user_id)
      if (row) actor = JSON.parse(row.identity)
      if (actor && v) wrap = await this.db.get<Wrap>('SELECT * FROM environment_key_wraps WHERE version_id=$1 AND recipient_device_id=$2 AND recipient_user_id=$3', v.id, actor.deviceId, auth.user_id)
    }
    const recipients = rights.send && actor ? await this.db.all<{ identity: string; login: string; hasWrap: boolean }>(`SELECT d.identity,u.login,EXISTS(SELECT 1 FROM environment_key_wraps w WHERE w.version_id=$3 AND w.recipient_device_id=d.id) AS "hasWrap"
      FROM devices d JOIN users u ON u.id=d.user_id JOIN effective_file_permissions p ON p.user_id=d.user_id
      WHERE p.org_id=$1 AND p.environment_id=$2 AND p.receive=1 AND d.status='active' ORDER BY u.login,d.id`, org, environment, v?.id ?? null) : []
    const wrapperActive = wrap ? !!await this.db.get("SELECT 1 FROM devices WHERE id=$1 AND user_id=$2 AND status='active'", wrap.wrapper_device_id, wrap.wrapper_user_id) : false
    return { sessionHash: await deviceHash(auth.token_hash), permissions: { receive: !!rights.receive, send: !!rights.send, externalShare: !!rights.external_share },
      generation: head.generation, endReason: head.end_reason, latest: v ? await this.summary(v) : null,
      access: !v ? 'empty' : !actor ? 'no_device' : wrap ? 'available' : 'needs_grant',
      wrap: wrap ? { recipient: JSON.parse(wrap.recipient_identity), wrapper: JSON.parse(wrap.wrapper_identity), wrap: wrap.wrap, wrapperActive } : null,
      recipients: recipients.map(row => ({ ...row, identity: JSON.parse(row.identity) })) }
  }
  private async reserve(auth: Session, org: string, environment: string, body: Record<string, unknown>) {
    fields(body, ['operationId', 'deviceId', 'expectedGeneration', 'size', 'digest', 'signature', 'wraps'])
    const versionId = id(body.operationId), actor = await this.identity(auth.user_id, id(body.deviceId)), rights = await this.rights(auth, org, environment, true)
    const expectedGeneration = id(body.expectedGeneration)
    if (!Number.isSafeInteger(body.size) || (body.size as number) < 40 || (body.size as number) > 16 * 1024 * 1024 || !validDigest(body.digest) || typeof body.signature !== 'string') throw new HttpError(400, 'invalid_upload')
    if (!Array.isArray(body.wraps) || !body.wraps.length || body.wraps.length > limits.organizationMembers * limits.userDevices) throw new HttpError(400, 'invalid_wraps')
    const wraps: PublicationWrapInput[] = [], recipients: DeviceIdentity[] = [], seen = new Set<string>()
    for (const value of body.wraps) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_wraps')
      fields(value, ['recipientDeviceId', 'wrap'])
      const device = id(value.recipientDeviceId)
      if (seen.has(device) || typeof value.wrap !== 'string') throw new HttpError(400, 'invalid_wraps')
      try { validatePublicationWrap(value.wrap) } catch { throw new HttpError(400, 'invalid_wraps') }
      seen.add(device); wraps.push({ recipientDeviceId: device, wrap: value.wrap }); recipients.push(await this.recipient(org, environment, device))
    }
    if (!seen.has(actor.deviceId)) throw new HttpError(400, 'self_wrap_required')
    const statement: PublicationStatement = { organizationId: org, projectId: rights.project_id, environmentId: environment, versionId,
      expectedGeneration, size: body.size as number, digest: body.digest, publisher: actor, signature: body.signature }
    if (!await verifyPublicationStatement(statement)) throw new HttpError(403, 'invalid_signature')
    const payload = await publicationPayloadDigest('publication-upload', { signature: statement.signature, wraps })
    const input = await deviceHash(JSON.stringify([statement, [...wraps].sort((a, b) => a.recipientDeviceId.localeCompare(b.recipientDeviceId))]))
    const scope = { userId: auth.user_id, orgId: org, kind: 'publication' as const, reservationId: versionId, requestId: environment }
    if (await uploadCancelled(this.db, scope)) return { versionId, status: 'cancelled' }
    const prior = await this.db.get<Version>('SELECT * FROM environment_versions WHERE id=$1', versionId)
    if (prior) {
      if (prior.org_id !== org || prior.environment_id !== environment || prior.publisher_user_id !== auth.user_id || prior.input_digest !== input) throw new HttpError(409, 'operation_conflict')
      return this.summary(prior)
    }
    this.open()
    const head = await this.head(org, environment)
    if (head.generation !== expectedGeneration) throw new HttpError(409, 'version_conflict')
    if (await this.db.get('SELECT 1 FROM stored_objects WHERE id=$1', versionId)) throw new HttpError(409, 'operation_conflict')
    const quota = await this.db.get<{ bytes: number; active: number }>("SELECT COALESCE(sum(size) FILTER(WHERE deleted_at IS NULL),0)::bigint AS bytes,count(*) FILTER(WHERE status IN('reserved','writing')) AS active FROM stored_objects WHERE org_id=$1", org)
    if (quota!.bytes + statement.size > limits.organizationStorageBytes || quota!.active >= limits.concurrentUploads) throw new HttpError(429, 'storage_limit')
    const recent = await this.db.get<{ n: number }>('SELECT count(*) AS n FROM creation_attempts WHERE user_id=$1 AND created_at>$2', auth.user_id, this.clock() - limits.creationWindowMs)
    if (recent!.n >= limits.creationAttempts) throw new HttpError(429, 'request_rate_limit')
    await this.db.run(`INSERT INTO environment_versions(id,org_id,project_id,environment_id,publisher_user_id,publisher_device_id,publisher_identity,expected_generation,size,digest,signature,input_digest,upload_payload_digest,status,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'reserved',$14)`, versionId, org, rights.project_id, environment, actor.userId, actor.deviceId, JSON.stringify(actor), expectedGeneration, statement.size, statement.digest, statement.signature, input, payload, this.clock())
    for (let i = 0; i < wraps.length; i++) await this.saveWrap(versionId, actor, recipients[i]!, wraps[i]!.wrap)
    const v = await this.version(org, environment, versionId)
    await this.event(auth.user_id, v, 'environment_version_reserved')
    return this.summary(v)
  }
  private async saveWrap(versionId: string, wrapper: DeviceIdentity, recipient: DeviceIdentity, wrap: string) {
    await this.db.run('INSERT INTO environment_key_wraps VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', versionId, recipient.userId, recipient.deviceId, wrapper.userId, wrapper.deviceId, JSON.stringify(recipient), JSON.stringify(wrapper), wrap, this.clock())
  }
  private async access(auth: Session, v: Version, action: PublicationAction, device: string, targetDevice?: string) {
    await this.rights(auth, v.org_id, v.environment_id, action !== 'publication-download')
    const actor = await this.identity(auth.user_id, device)
    let generation: string, target = actor
    if (action === 'publication-upload') {
      this.open()
      if (v.publisher_user_id !== actor.userId || v.publisher_device_id !== actor.deviceId || v.publisher_identity !== JSON.stringify(actor)) throw new HttpError(403, 'publisher_required')
      if (!['reserved', 'writing'].includes(v.status) || v.ended_at !== null) throw new HttpError(409, 'upload_unavailable')
      const head = await this.head(v.org_id, v.environment_id)
      if (head.generation !== v.expected_generation) throw new HttpError(409, 'version_conflict')
      generation = v.expected_generation
    } else {
      generation = (await this.latest(v)).generation
      if (action !== 'publication-remove') await this.ownWrap(v, actor)
      if (action === 'publication-grant') { this.open(); target = await this.recipient(v.org_id, v.environment_id, id(targetDevice)) }
    }
    return { actor, target, generation }
  }
  private scope(v: Version, generation: string, target: DeviceIdentity, payloadDigest: string): PublicationScope {
    return { organizationId: v.org_id, projectId: v.project_id, environmentId: v.environment_id, versionId: v.id,
      generation, digest: v.digest, targetDeviceId: target.deviceId, payloadDigest }
  }
  private async challenge(auth: Session, v: Version, body: Record<string, unknown>) {
    fields(body, ['action', 'deviceId', 'targetDeviceId', 'payloadDigest'])
    if (!['publication-upload', 'publication-download', 'publication-grant', 'publication-remove'].includes(body.action as string) || !validDigest(body.payloadDigest)) throw new HttpError(400, 'invalid_input')
    const action = body.action as PublicationAction, { actor, target, generation } = await this.access(auth, v, action, id(body.deviceId), body.targetDeviceId === undefined ? undefined : id(body.targetDeviceId))
    if (action !== 'publication-grant') {
      if (body.targetDeviceId !== undefined && body.targetDeviceId !== actor.deviceId) throw new HttpError(400, 'invalid_input')
      const digest = action === 'publication-upload' ? v.upload_payload_digest : await publicationPayloadDigest(action === 'publication-download' ? 'publication-download' : 'publication-remove', {})
      if (digest !== body.payloadDigest) throw new HttpError(403, 'invalid_proof')
    }
    const now = this.clock(), count = await this.db.get<{ n: number }>('SELECT count(*) AS n FROM environment_file_challenges WHERE session_hash=$1 AND expires_at>$2', auth.token_hash, now)
    if (count!.n >= 10) throw new HttpError(429, 'challenge_limit')
    const challenge: PublicationDeviceChallenge = { id: randomUUID(), action, actor, target, sessionHash: await deviceHash(auth.token_hash), issuedAt: now, expiresAt: now + DEVICE_CHALLENGE_MS,
      scope: this.scope(v, generation, target, body.payloadDigest) }
    const { wire, secretHash } = await encryptDeviceChallenge(challenge)
    await this.db.run('INSERT INTO environment_file_challenges VALUES($1,$2,$3,$4,$5,$6)', challenge.id, auth.token_hash, v.id, JSON.stringify(challenge), secretHash, challenge.expiresAt)
    return wire
  }
  private async proof(auth: Session, v: Version, action: PublicationAction, device: string, challengeId: unknown, proof: unknown, payload: string, targetDevice?: string) {
    const { actor, target, generation } = await this.access(auth, v, action, device, targetDevice)
    const row = await this.db.get<{ body: string; secret_hash: string }>('SELECT body,secret_hash FROM environment_file_challenges WHERE id=$1 AND session_hash=$2 AND version_id=$3 AND expires_at>$4', id(challengeId), auth.token_hash, v.id, this.clock())
    if (!row || typeof proof !== 'string') throw new HttpError(403, 'invalid_proof')
    const challenge: PublicationDeviceChallenge = JSON.parse(row.body)
    if (challenge.action !== action || JSON.stringify(challenge.actor) !== JSON.stringify(actor) || JSON.stringify(challenge.target) !== JSON.stringify(target) ||
      JSON.stringify(challenge.scope) !== JSON.stringify(this.scope(v, generation, target, payload)) || !await verifyDeviceProof(challenge, proof, row.secret_hash) || this.clock() < challenge.issuedAt || this.clock() >= challenge.expiresAt) throw new HttpError(403, 'invalid_proof')
    await this.db.run('DELETE FROM environment_file_challenges WHERE id=$1', challenge.id)
    return { actor, target, generation }
  }
  private async upload(request: Request, session: () => Promise<Session>, auth: Session, org: string, environment: string, versionId: string) {
    if (request.headers.get('content-type') !== 'application/octet-stream') throw new HttpError(415, 'binary_required')
    const v = await this.db.transaction(async () => {
      await this.current(session, auth, org)
      const v = await this.version(org, environment, versionId)
      await this.proof(auth, v, 'publication-upload', v.publisher_device_id, request.headers.get('x-device-challenge'), request.headers.get('x-device-proof'), v.upload_payload_digest)
      if (v.status !== 'reserved') throw new HttpError(409, 'upload_unavailable')
      await this.db.run("UPDATE environment_versions SET status='writing',write_until=$1 WHERE id=$2", this.clock() + 5 * 60_000, v.id)
      return v
    })
    try {
      await this.objects!.write(v.id, request.body, v.size, v.digest)
      return await this.db.transaction(async () => {
        await this.current(session, auth, org)
        const current = await this.version(org, environment, v.id)
        await this.access(auth, current, 'publication-upload', v.publisher_device_id)
        if (current.status !== 'writing' || await uploadCancelled(this.db, { userId: auth.user_id, orgId: org, kind: 'publication', reservationId: v.id, requestId: environment })) throw new HttpError(409, 'upload_unavailable')
        const head = await this.head(org, environment), generation = randomUUID()
        if (head.generation !== v.expected_generation) throw new HttpError(409, 'version_conflict')
        if (head.version_id) {
          await this.db.run("UPDATE environment_versions SET ended_at=$1,end_reason='replaced' WHERE id=$2 AND ended_at IS NULL", this.clock(), head.version_id)
          await this.db.run('DELETE FROM environment_key_wraps WHERE version_id=$1', head.version_id)
        }
        await this.db.run("UPDATE environment_versions SET status='committed',published_at=$1,write_until=NULL WHERE id=$2", this.clock(), v.id)
        await this.db.run('UPDATE environment_publication_heads SET version_id=$1,generation=$2,end_reason=NULL WHERE environment_id=$3', v.id, generation, environment)
        await this.event(auth.user_id, v, 'environment_version_published')
        return Response.json({ version: await this.summary(await this.version(org, environment, v.id)), generation })
      })
    } catch (error) {
      await this.db.transaction(async () => {
        await this.db.run("UPDATE environment_versions SET status=CASE WHEN status='writing' THEN 'failed' ELSE status END,ended_at=COALESCE(ended_at,$1),end_reason=COALESCE(end_reason,'upload_failed'),write_until=NULL WHERE id=$2 AND status!='committed'", this.clock(), v.id)
        await this.db.run('DELETE FROM environment_key_wraps WHERE version_id=$1 AND EXISTS(SELECT 1 FROM environment_versions WHERE id=$1 AND ended_at IS NOT NULL)', v.id)
      })
      throw error
    }
  }
  private async download(auth: Session, v: Version, body: Record<string, unknown>) {
    fields(body, ['deviceId', 'id', 'proof'])
    await this.proof(auth, v, 'publication-download', id(body.deviceId), body.id, body.proof, await publicationPayloadDigest('publication-download', {}))
    const day = Math.floor(this.clock() / DAY)
    const quota = await this.db.get<{ bytes: number; active: number }>(`SELECT COALESCE(sum(bytes) FILTER(WHERE org_id=$1 AND day=$2),0)::bigint AS bytes,
      count(*) FILTER(WHERE object_id=$3 AND finished=0 AND expires_at>$4) AS active FROM all_download_leases`, v.org_id, day, v.id, this.clock())
    if (quota!.bytes + v.size > limits.organizationDailyDownloadBytes || quota!.active >= limits.concurrentDownloads) throw new HttpError(429, 'download_limit')
    const lease = randomUUID()
    await this.db.run('INSERT INTO environment_download_leases(id,version_id,org_id,day,bytes,expires_at) VALUES($1,$2,$3,$4,$5,$6)', lease, v.id, v.org_id, day, v.size, this.clock() + 5 * 60_000)
    const stream = await this.objects!.read(v.id, v.size, async bytes => { await this.db.transaction(async () => { await this.db.run('UPDATE environment_download_leases SET bytes=$1,finished=1 WHERE id=$2', bytes, lease) }) })
    await this.event(auth.user_id, v, 'environment_download_allowed')
    return new Response(stream, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(v.size) } })
  }
  private async grant(auth: Session, v: Version, body: Record<string, unknown>) {
    fields(body, ['deviceId', 'targetDeviceId', 'wrap', 'id', 'proof'])
    if (typeof body.wrap !== 'string') throw new HttpError(400, 'invalid_wraps')
    try { validatePublicationWrap(body.wrap) } catch { throw new HttpError(400, 'invalid_wraps') }
    const targetId = id(body.targetDeviceId), payload = await publicationPayloadDigest('publication-grant', { targetDeviceId: targetId, wrap: body.wrap })
    const { actor, target } = await this.proof(auth, v, 'publication-grant', id(body.deviceId), body.id, body.proof, payload, targetId)
    const prior = await this.db.get<Wrap>('SELECT * FROM environment_key_wraps WHERE version_id=$1 AND recipient_device_id=$2', v.id, target.deviceId)
    if (prior) {
      if (prior.wrapper_identity !== JSON.stringify(actor) || prior.recipient_identity !== JSON.stringify(target) || prior.wrap !== body.wrap) throw new HttpError(409, 'grant_exists')
    } else { await this.saveWrap(v.id, actor, target, body.wrap); await this.event(auth.user_id, v, 'environment_key_granted') }
    return { versionId: v.id, recipientDeviceId: target.deviceId, granted: true }
  }
  private async remove(auth: Session, v: Version, body: Record<string, unknown>) {
    fields(body, ['deviceId', 'expectedGeneration', 'id', 'proof'])
    const head = await this.head(v.org_id, v.environment_id)
    if (head.generation !== id(body.expectedGeneration)) throw new HttpError(409, 'version_conflict')
    await this.proof(auth, v, 'publication-remove', id(body.deviceId), body.id, body.proof, await publicationPayloadDigest('publication-remove', {}))
    const generation = randomUUID()
    await this.db.run("UPDATE environment_versions SET ended_at=$1,end_reason='removed' WHERE id=$2", this.clock(), v.id)
    await this.db.run("UPDATE environment_publication_heads SET version_id=NULL,generation=$1,end_reason='removed' WHERE environment_id=$2", generation, v.environment_id)
    await this.db.run('DELETE FROM environment_key_wraps WHERE version_id=$1', v.id)
    await this.db.run('DELETE FROM environment_file_challenges WHERE version_id=$1', v.id)
    await this.event(auth.user_id, v, 'environment_version_removed')
    return { generation, endReason: 'removed', latest: null }
  }
  private async cancel(auth: Session, org: string, environment: string, versionId: string, body: Record<string, unknown>) {
    fields(body, ['operationId']); id(body.operationId)
    const v = await this.db.get<Version>('SELECT * FROM environment_versions WHERE id=$1', versionId)
    if (v) {
      if (v.org_id !== org || v.environment_id !== environment || v.publisher_user_id !== auth.user_id) throw new HttpError(403, 'publisher_required')
      if (v.status === 'committed') return this.summary(v)
    } else await this.rights(auth, org, environment, true)
    await fenceUpload(this.db, { userId: auth.user_id, orgId: org, kind: 'publication', reservationId: versionId, requestId: environment }, this.clock(), !v)
    if (!v) return { versionId, status: 'cancelled' }
    await this.db.run("UPDATE environment_versions SET status='cancelled',ended_at=COALESCE(ended_at,$1),end_reason=COALESCE(end_reason,'cancelled') WHERE id=$2", this.clock(), versionId)
    await this.db.run('DELETE FROM environment_key_wraps WHERE version_id=$1', versionId)
    await this.event(auth.user_id, v, 'environment_upload_cancelled')
    return this.summary(await this.version(org, environment, versionId))
  }
  async handle(request: Request, session: () => Promise<Session>): Promise<Response> {
    if (!this.objects) throw new HttpError(503, 'storage_unavailable')
    const url = new URL(request.url), route = /^\/organizations\/([^/]+)\/environments\/([^/]+)\/files(?:\/versions(?:\/([^/]+)(?:\/(challenge|content|download|grants|remove|cancel))?)?)?$/.exec(url.pathname)
    if (!route) throw new HttpError(404)
    if (!['GET', 'POST'].includes(request.method)) throw new HttpError(405)
    const org = id(route[1]), environment = id(route[2]), versionId = route[3] ? id(route[3]) : undefined, action = route[4], auth = await session()
    if (request.method === 'POST' && action === 'content' && versionId) return this.upload(request, session, auth, org, environment, versionId)
    const body = request.method === 'POST' ? await jsonBody(request, url.pathname.endsWith('/versions') ? 32768 : 8192) : undefined
    return this.db.transaction(async () => {
      await this.current(session, auth, org)
      if (request.method === 'POST' && action === 'cancel' && versionId) return Response.json(await this.cancel(auth, org, environment, versionId, body!))
      if (!versionId) {
        if (url.pathname.endsWith('/versions') && body) return Response.json(await this.reserve(auth, org, environment, body))
        if (request.method === 'GET' && !url.pathname.endsWith('/versions')) return Response.json(await this.info(auth, org, environment, url.searchParams.get('device') ?? undefined))
        throw new HttpError(404)
      }
      await this.rights(auth, org, environment)
      const v = await this.version(org, environment, versionId)
      if (request.method === 'GET' && !action) {
        if (v.publisher_user_id !== auth.user_id) throw new HttpError(403, 'publisher_required')
        const head = await this.head(org, environment)
        return Response.json({ version: await this.summary(v), generation: head.generation, isLatest: head.version_id === v.id })
      }
      if (!body) throw new HttpError(404)
      if (action === 'challenge') return Response.json(await this.challenge(auth, v, body))
      if (action === 'download') return this.download(auth, v, body)
      if (action === 'grants') return Response.json(await this.grant(auth, v, body))
      if (action === 'remove') return Response.json(await this.remove(auth, v, body))
      throw new HttpError(404)
    }).catch(async error => {
      if (action === 'download') await this.auditDenial(auth.user_id, org, environment, versionId!, error)
      throw error
    })
  }
  private async auditDenial(actor: string, org: string, environment: string, versionId: string, error: unknown) {
    if (!(error instanceof HttpError) || ![400, 401, 403, 404, 409, 410, 429].includes(error.status)) return
    try {
      await this.db.transaction(async () => {
        await this.db.run(`INSERT INTO organization_events(org_id,actor_id,target_id,event,created_at)
          SELECT org_id,$1,id,'environment_download_denied',$2 FROM environment_versions WHERE id=$3 AND org_id=$4 AND environment_id=$5 AND status='committed'
          AND NOT EXISTS(SELECT 1 FROM organization_events WHERE target_id=$3 AND event='environment_download_denied' AND created_at>$6)`, actor, this.clock(), versionId, org, environment, this.clock() - 60_000)
      })
    } catch { console.error('Environment download denial audit failed') }
  }
  async prune() {
    await this.db.transaction(async () => {
      await invalidatePublications(this.db, this.clock())
      await this.db.run('DELETE FROM environment_file_challenges WHERE expires_at<=$1', this.clock())
      await this.db.run('DELETE FROM environment_download_leases WHERE day<$1', Math.floor(this.clock() / DAY) - 2)
    })
    if (!this.objects) return
    const rows = await this.db.all<{ id: string }>('SELECT id FROM environment_versions WHERE ended_at IS NOT NULL AND deleted_at IS NULL AND (write_until IS NULL OR write_until<=$1)', this.clock())
    for (const row of rows) {
      try {
        await this.objects.remove(row.id)
        await this.db.transaction(async () => { await this.db.run('UPDATE environment_versions SET deleted_at=$1 WHERE id=$2 AND ended_at IS NOT NULL', this.clock(), row.id) })
      } catch {
        console.error('Encrypted environment object deletion failed')
        await this.db.run("INSERT INTO organization_events(org_id,target_id,event,created_at) SELECT org_id,id,'object_delete_failed',$1 FROM environment_versions WHERE id=$2", this.clock(), row.id)
      }
    }
    await this.db.transaction(async () => { await this.db.run('DELETE FROM environment_versions WHERE deleted_at IS NOT NULL AND ended_at<=$1', this.clock() - 30 * DAY) })
  }
}

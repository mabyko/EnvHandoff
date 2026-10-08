import { fenceUpload, uploadCancelled } from './upload-cancellations.ts'
import { limits } from './limits.ts'
import { randomUUID } from 'node:crypto'
import type { Database } from './database.ts'
import { fields, HttpError, jsonBody } from './http.ts'
import { invalidateRequests, invalidateTransfers } from './lifecycle.ts'
import { Objects } from './objects.ts'
import { auditDownloadDenied } from './download-audit.ts'
import { deviceId, deviceHash, encryptDeviceChallenge, verifyDeviceProof, DEVICE_CHALLENGE_MS } from '@envhandoff/protocol/device-proof'
import type { DeviceIdentity, DeviceChallenge } from '@envhandoff/protocol/device-proof'

const DAY = 86_400_000, MAX = 16 * 1024 * 1024 + 134
function id(value: unknown): string { try { return deviceId(value as string) } catch { throw new HttpError(400, 'invalid_input') } }
type Session = { user_id: string; token_hash: string }
type RequestRow = { id: string; org_id: string; environment_id: string; receiver_id: string; sender_id: string; receiver_device_id: string; status: string; expires_at: number }
type Upload = { id: string; request_id: string; org_id: string; sender_id: string; sender_device_id: string; project_id: string; size: number; digest: string; retention_days: number; status: string; created_at: number; available_until: number | null; revoked_at: number | null; acknowledged_at: number | null; ended_at: number | null; deleted_at: number | null; sender_identity: string; receiver_identity: string }

export function transferState(u: Upload, now: number) { return u.revoked_at !== null ? 'revoked' : u.available_until !== null && u.available_until <= now ? 'expired' : u.status === 'committed' ? 'available' : u.status }

export class Transfers {
  private readonly db: Database
  private readonly objects?: Objects
  private readonly clock: () => number
  private readonly acceptNewTransfers: boolean
  constructor(db: Database, root?: string, clock = Date.now, acceptNewTransfers = true) { this.db = db; this.clock = clock; this.acceptNewTransfers = acceptNewTransfers; if (root) this.objects = new Objects(root) }
  async prune() {
    await this.db.transaction(async () => {
      await invalidateRequests(this.db, this.clock())
      await this.db.run('DELETE FROM transfer_challenges WHERE expires_at <= $1', this.clock())
      await this.db.run('DELETE FROM download_leases WHERE day < $1', Math.floor(this.clock() / DAY) - 2)
    })
    if (!this.objects) return
    // Deletion is retried each minute, and capacity is held until physical removal succeeds.
    const rows = await this.db.all<{ id: string }>('SELECT id FROM uploads WHERE ended_at IS NOT NULL AND deleted_at IS NULL AND (write_until IS NULL OR write_until <= $1)', this.clock())
    for (const row of rows) {
      try {
        await this.objects.remove(row.id)
        await this.db.transaction(async () => { await this.db.run('UPDATE uploads SET deleted_at=$1 WHERE id=$2 AND ended_at IS NOT NULL', this.clock(), row.id) })
      } catch {
        console.error('Encrypted object deletion failed')
        await this.db.run("INSERT INTO organization_events (org_id,target_id,event,created_at) SELECT org_id,id,'object_delete_failed',$1 FROM uploads WHERE id=$2", this.clock(), row.id)
      }
    }
    await this.db.transaction(async () => {
      await this.db.run('DELETE FROM uploads WHERE deleted_at IS NOT NULL AND ended_at <= $1', this.clock() - 30 * DAY)
    })
  }
  private async current(session: () => Promise<Session>, auth: Session, org: string) {
    if ((await session()).token_hash !== auth.token_hash) throw new HttpError(401, 'session_expired')
    await this.db.run('UPDATE sessions SET last_seen=$1 WHERE token_hash=$2', this.clock(), auth.token_hash)
    await invalidateRequests(this.db, this.clock(), {organizationId:org})
  }
  private async request(orgId: string, requestId: string): Promise<RequestRow> {
    const row = await this.db.get<RequestRow>('SELECT * FROM file_requests WHERE id=$1 AND org_id=$2', requestId, orgId)
    if (!row) throw new HttpError(404, 'request_unavailable')
    return row
  }
  private async owner(auth: Session, r: RequestRow) {
    return !!await this.db.get("SELECT 1 FROM memberships m JOIN organizations o ON o.id=m.org_id WHERE m.org_id=$1 AND m.user_id=$2 AND m.role='owner' AND o.active=1", r.org_id, auth.user_id)
  }
  private async participant(auth: Session, r: RequestRow, manage = false) {
    if (![r.sender_id, r.receiver_id].includes(auth.user_id) && !(manage && await this.owner(auth, r))) throw new HttpError(404, 'request_unavailable')
  }
  private async sender(auth: Session, r: RequestRow, device?: string) {
    if (auth.user_id !== r.sender_id) throw new HttpError(403, 'sender_required')
    if (!await this.db.get('SELECT 1 FROM effective_file_permissions WHERE org_id=$1 AND environment_id=$2 AND user_id=$3 AND send=1', r.org_id, r.environment_id, auth.user_id)) throw new HttpError(403, 'file_permission_required')
    if (device) return this.identity(auth.user_id, device)
  }
  private async identity(userId: string, deviceId: string): Promise<DeviceIdentity> {
    const device = await this.db.get<{ identity: string }>("SELECT identity FROM devices WHERE id=$1 AND user_id=$2 AND status='active'", deviceId, userId)
    if (!device) throw new HttpError(403, 'device_required')
    return JSON.parse(device.identity)
  }
  private async upload(r: RequestRow, uploadId?: string): Promise<Upload> {
    const u = uploadId ? await this.db.get<Upload>('SELECT * FROM uploads WHERE id=$1 AND request_id=$2', uploadId, r.id)
      : await this.db.get<Upload>("SELECT * FROM uploads WHERE request_id=$1 AND status='committed'", r.id)
    if (!u) throw new HttpError(404, 'transfer_unavailable')
    return u
  }
  private binding(r: RequestRow, u: Upload) {
    return { organizationId: r.org_id, projectId: u.project_id, environmentId: r.environment_id, requestId: r.id, transferId: u.id,
      senderUserId: r.sender_id, senderDeviceId: u.sender_device_id, recipientUserId: r.receiver_id, recipientDeviceId: r.receiver_device_id }
  }
  private summary(u: Upload) { return { id: u.id, status: transferState(u, this.clock()), size: u.size, digest: u.digest, expiresAt: u.available_until, acknowledgedAt: u.acknowledged_at } }
  private async access(auth: Session, r: RequestRow, u: Upload, action: 'upload' | 'download' | 'ack') {
    if (action === 'upload') {
      if (!this.acceptNewTransfers) throw new HttpError(503, 'beta_closed')
      await this.sender(auth, r, u.sender_device_id)
      if (r.status !== 'approved' || !['reserved','writing'].includes(u.status)) throw new HttpError(409, 'upload_unavailable')
    } else {
      if (auth.user_id !== r.receiver_id) throw new HttpError(403, 'receiver_required')
      await this.identity(auth.user_id, r.receiver_device_id)
      if (transferState(u, this.clock()) !== 'available' || u.ended_at !== null) throw new HttpError(410, 'transfer_unavailable')
    }
  }
  private async prepare(auth: Session, r: RequestRow, body: Record<string, unknown>) {
    fields(body, ['operationId','deviceId','size','digest','retentionDays'])
    const uploadId = id(body.operationId), senderId = id(body.deviceId)
    const sender = await this.sender(auth, r, senderId)
    const size = body.size as number, digest = body.digest as string, days = body.retentionDays as number
    if (!Number.isSafeInteger(size) || size < 174 || size > MAX || typeof digest !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(digest) || Buffer.from(digest, 'base64url').toString('base64url') !== digest || ![1,3,7].includes(days)) throw new HttpError(400, 'invalid_upload')
    if (await uploadCancelled(this.db,{userId:auth.user_id,orgId:r.org_id,kind:'team',reservationId:uploadId,requestId:r.id})) return {id:uploadId,status:'cancelled'}
    const prior = await this.db.get<Upload>('SELECT * FROM uploads WHERE id=$1', uploadId)
    if (prior) {
      if (prior.request_id !== r.id || prior.sender_device_id !== senderId || prior.size !== size || prior.digest !== digest || prior.retention_days !== days) throw new HttpError(409, 'operation_conflict')
      return this.summary(prior)
    }
    if (!this.acceptNewTransfers) throw new HttpError(503, 'beta_closed')
    if (await this.db.get('SELECT 1 FROM external_shares WHERE id=$1',uploadId)) throw new HttpError(409,'operation_conflict')
    if (r.status !== 'approved') throw new HttpError(409, 'request_closed')
    if (await this.db.get("SELECT 1 FROM uploads WHERE request_id=$1 AND status IN ('reserved','writing','committed')", r.id)) throw new HttpError(409, 'upload_in_progress')
    const quota = await this.db.get<{ bytes: number; active: number }>("SELECT COALESCE(sum(size) FILTER(WHERE deleted_at IS NULL),0)::bigint AS bytes,count(*) FILTER(WHERE status IN ('reserved','writing')) AS active FROM stored_objects WHERE org_id=$1", r.org_id)
    if (quota!.bytes + size > limits.organizationStorageBytes || quota!.active >= limits.concurrentUploads) throw new HttpError(429, 'storage_limit')
    const recent = await this.db.get<{ n: number }>(`SELECT count(*) AS n FROM creation_attempts WHERE user_id=$1 AND created_at>$2`, auth.user_id, this.clock() - limits.creationWindowMs)
    if (recent!.n >= limits.creationAttempts) throw new HttpError(429, 'request_rate_limit')
    const receiver = await this.identity(r.receiver_id, r.receiver_device_id)
    const env = await this.db.get<{ project_id: string }>('SELECT project_id FROM environments WHERE id=$1', r.environment_id)
    await this.db.run(`INSERT INTO uploads(id,request_id,org_id,sender_id,sender_device_id,project_id,size,digest,retention_days,status,created_at,sender_identity,receiver_identity)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'reserved',$10,$11,$12)`, uploadId,r.id,r.org_id,auth.user_id,senderId,env!.project_id,size,digest,days,this.clock(),JSON.stringify(sender),JSON.stringify(receiver))
    return this.summary(await this.upload(r, uploadId))
  }
  private async cancel(auth: Session, r: RequestRow, uploadId: string, body: Record<string, unknown>) {
    fields(body,['operationId']); id(body.operationId)
    if (auth.user_id!==r.sender_id) throw new HttpError(403,'sender_required')
    const existing=await this.db.get<Upload>('SELECT * FROM uploads WHERE id=$1',uploadId)
    if (existing && (existing.request_id!==r.id || existing.sender_id!==auth.user_id)) throw new HttpError(404,'transfer_unavailable')
    if (existing && transferState(existing,this.clock())==='available' && existing.ended_at===null) return this.summary(existing)
    await fenceUpload(this.db,{userId:auth.user_id,orgId:r.org_id,kind:'team',reservationId:uploadId,requestId:r.id},this.clock(),!existing)
    if (!existing) return {id:uploadId,status:'cancelled'}
    if (['reserved','writing'].includes(existing.status)) {
      await this.db.run("UPDATE uploads SET status='cancelled',ended_at=COALESCE(ended_at,$1) WHERE id=$2",this.clock(),uploadId)
      await this.event(auth,existing,'upload_cancelled')
    }
    return this.summary(await this.upload(r,uploadId))
  }
  private async challenge(auth: Session, r: RequestRow, u: Upload, body: Record<string, unknown>) {
    fields(body, ['action','deviceId'])
    if (!['upload','download','ack'].includes(body.action as string)) throw new HttpError(400, 'invalid_input')
    const action = body.action as 'upload' | 'download' | 'ack'
    await this.access(auth, r, u, action)
    const device = action === 'upload' ? u.sender_device_id : r.receiver_device_id
    if (id(body.deviceId) !== device) throw new HttpError(403, 'device_required')
    const actor = await this.identity(auth.user_id, device), now = this.clock()
    const challenge: DeviceChallenge = { id: randomUUID(), action, actor, target: actor, sessionHash: await deviceHash(auth.token_hash), issuedAt: now, expiresAt: now + DEVICE_CHALLENGE_MS,
      scope: { organizationId: r.org_id, requestId: r.id, transferId: u.id, digest: u.digest } }
    const count = await this.db.get<{ n: number }>('SELECT count(*) AS n FROM transfer_challenges WHERE session_hash=$1 AND expires_at>$2', auth.token_hash, now)
    if (count!.n >= 10) throw new HttpError(429, 'challenge_limit')
    const { wire, secretHash } = await encryptDeviceChallenge(challenge)
    await this.db.run('INSERT INTO transfer_challenges VALUES($1,$2,$3,$4,$5,$6)', challenge.id,auth.token_hash,u.id,JSON.stringify(challenge),secretHash,challenge.expiresAt)
    return wire
  }
  private async proof(auth: Session, r: RequestRow, u: Upload, action: 'upload' | 'download' | 'ack', challengeId: unknown, proof: unknown) {
    await this.access(auth, r, u, action)
    const row = await this.db.get<{ body: string; secret_hash: string }>('SELECT body,secret_hash FROM transfer_challenges WHERE id=$1 AND session_hash=$2 AND upload_id=$3 AND expires_at>$4', id(challengeId),auth.token_hash,u.id,this.clock())
    if (!row || typeof proof !== 'string') throw new HttpError(403, 'invalid_proof')
    const challenge = JSON.parse(row.body) as DeviceChallenge
    if (challenge.action !== action || !await verifyDeviceProof(challenge, proof, row.secret_hash)) throw new HttpError(403, 'invalid_proof')
    if (this.clock() < challenge.issuedAt || this.clock() >= challenge.expiresAt) throw new HttpError(403, 'invalid_proof')
    await this.db.run('DELETE FROM transfer_challenges WHERE id=$1', challenge.id)
  }
  private async mutation(auth: Session, r: RequestRow, u: Upload, action: string, body: Record<string, unknown>, apply: () => Promise<unknown>) {
    const operationId = id(body.operationId), input = JSON.stringify([r.org_id,r.id,u.id,action,body.id ?? null,body.proof ?? null])
    const prior = await this.db.get<{ input:string; result:string }>('SELECT input,result FROM request_operations WHERE user_id=$1 AND operation_id=$2',auth.user_id,operationId)
    if (prior) { if (prior.input !== input) throw new HttpError(409,'operation_conflict'); return JSON.parse(prior.result) }
    const result = await apply()
    await this.db.run('INSERT INTO request_operations VALUES($1,$2,$3,$4,$5,$6)',auth.user_id,operationId,r.id,input,JSON.stringify(result),this.clock())
    return result
  }
  private async content(request: Request, session: () => Promise<Session>, auth: Session, org: string, requestId: string, uploadId: string) {
    if (request.headers.get('content-type') !== 'application/octet-stream') throw new HttpError(415, 'binary_required')
    const u = await this.db.transaction(async () => {
      await this.current(session, auth, org)
      const r = await this.request(org, requestId), u = await this.upload(r, uploadId)
      if (u.status !== 'reserved') throw new HttpError(409, 'upload_unavailable')
      await this.proof(auth,r,u,'upload',request.headers.get('x-device-challenge'),request.headers.get('x-device-proof'))
      await this.db.run("UPDATE uploads SET status='writing',write_until=$1 WHERE id=$2", this.clock()+5*60_000,u.id)
      return u
    })
    try {
      await this.objects!.write(u.id, request.body, u.size, u.digest)
      return await this.db.transaction(async () => {
        await this.current(session, auth, org)
        const r = await this.request(org,requestId), current = await this.upload(r,u.id)
        await this.access(auth,r,current,'upload')
        if (current.status !== 'writing') throw new HttpError(409, 'upload_unavailable')
        const now = this.clock()
        await this.db.run("UPDATE uploads SET status='committed',available_until=$1,write_until=NULL WHERE id=$2", now+u.retention_days*DAY,u.id)
        await this.db.run("UPDATE file_requests SET status='fulfilled' WHERE id=$1", r.id)
        await this.event(auth,u,'upload_committed')
        return Response.json(this.summary(await this.upload(r,u.id)))
      })
    } catch (error) {
      await this.db.transaction(async () => { await this.db.run("UPDATE uploads SET status=CASE WHEN status='writing' THEN 'failed' ELSE status END,ended_at=COALESCE(ended_at,$1),write_until=NULL WHERE id=$2 AND status!='committed'",this.clock(),u.id) })
      throw error
    }
  }
  private async event(auth: Session, u: Upload, event: string) {
    await this.db.run('INSERT INTO organization_events(org_id,actor_id,target_id,event,created_at) VALUES($1,$2,$3,$4,$5)',u.org_id,auth.user_id,u.id,event,this.clock())
  }
  async handle(request: Request, session: () => Promise<Session>): Promise<Response> {
    if (!this.objects) throw new HttpError(503, 'storage_unavailable')
    const auth = await session(), path = new URL(request.url).pathname
    const route = /^\/organizations\/([^/]+)\/requests\/([^/]+)\/(transfer|uploads)(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(path)
    if (!route) throw new HttpError(404)
    const org = id(route[1]), requestId = id(route[2]), kind = route[3], uploadId = kind === 'uploads' && route[4] ? id(route[4]) : undefined
    const action = kind === 'transfer' ? route[4] : route[5]
    if (!['GET','POST'].includes(request.method)) throw new HttpError(405)
    if (request.method === 'POST' && kind === 'uploads' && uploadId && action === 'content') return this.content(request,session,auth,org,requestId,uploadId)
    const body = request.method === 'POST' ? await jsonBody(request) : undefined
    return this.db.transaction(async () => {
      await this.current(session,auth,org)
      const r = await this.request(org,requestId)
      await this.participant(auth,r,action === 'revoke')
      if (kind === 'uploads' && !uploadId && body && !action) return Response.json(await this.prepare(auth,r,body))
      if (kind === 'transfer' && !action && !body && r.status === 'approved') {
        await this.sender(auth,r)
        const env = await this.db.get<{ project_id: string }>('SELECT project_id FROM environments WHERE id=$1',r.environment_id)
        const pendingUpload = await this.db.get("SELECT id,status FROM uploads WHERE request_id=$1 AND status IN ('reserved','writing')", r.id)
        return Response.json({ pendingUpload, requestId:r.id,organizationId:r.org_id,projectId:env!.project_id,environmentId:r.environment_id,senderUserId:r.sender_id,recipientUserId:r.receiver_id,recipientDeviceId:r.receiver_device_id,receiver:await this.identity(r.receiver_id,r.receiver_device_id),sessionHash:await deviceHash(auth.token_hash) })
      }
      if (body && action==='cancel' && kind==='uploads' && uploadId) return Response.json(await this.cancel(auth,r,uploadId,body))
      const u = await this.upload(r,uploadId)
      if (!body && !action) {
        if (kind === 'uploads') await this.sender(auth,r)
        const available = transferState(u,this.clock()) === 'available'
        return Response.json({ ...this.summary(u), ...(available ? { binding:this.binding(r,u),sender:JSON.parse(u.sender_identity),receiver:JSON.parse(u.receiver_identity),sessionHash:await deviceHash(auth.token_hash) } : {}) })
      }
      if (!body) throw new HttpError(404)
      if (action === 'challenge') return Response.json(await this.challenge(auth,r,u,body))
      if (action === 'revoke' && kind === 'transfer') {
        fields(body,['operationId']); id(body.operationId)
        return Response.json(await this.mutation(auth,r,u,'revoke',body,async () => {
          await this.db.run('UPDATE uploads SET revoked_at=COALESCE(revoked_at,$1),ended_at=COALESCE(ended_at,$1) WHERE id=$2',this.clock(),u.id)
          await invalidateTransfers(this.db,this.clock(),{requestId:r.id})
          await this.event(auth,u,'transfer_revoked')
          return { ...this.summary(u),status:'revoked' }
        }))
      }
      if (kind === 'transfer' && (action === 'content' || action === 'ack')) {
        fields(body,action === 'ack' ? ['id','proof','operationId'] : ['id','proof'])
        if (action === 'ack') {
          await this.access(auth,r,u,'ack')
          return Response.json(await this.mutation(auth,r,u,'ack',body,async () => {
            await this.proof(auth,r,u,'ack',body.id,body.proof)
            await this.db.run('UPDATE uploads SET acknowledged_at=COALESCE(acknowledged_at,$1) WHERE id=$2',this.clock(),u.id)
            await this.event(auth,u,'transfer_acknowledged')
            return this.summary(await this.upload(r,u.id))
          }))
        }
        await this.proof(auth,r,u,'download',body.id,body.proof)
        const day = Math.floor(this.clock()/DAY)
        const quota = await this.db.get<{ bytes: number; active: number }>(`SELECT COALESCE(sum(bytes) FILTER(WHERE org_id=$1 AND day=$2),0)::bigint AS bytes,
          count(*) FILTER(WHERE object_id=$3 AND finished=0 AND expires_at>$4) AS active FROM all_download_leases`,r.org_id,day,u.id,this.clock())
        if (quota!.bytes + u.size > limits.organizationDailyDownloadBytes || quota!.active >= limits.concurrentDownloads) throw new HttpError(429,'download_limit')
        const lease = randomUUID()
        await this.db.run('INSERT INTO download_leases(id,upload_id,org_id,day,bytes,expires_at) VALUES($1,$2,$3,$4,$5,$6)',lease,u.id,r.org_id,day,u.size,this.clock()+5*60_000)
        const stream = await this.objects!.read(u.id,u.size,async bytes => {
          await this.db.transaction(async () => { await this.db.run('UPDATE download_leases SET bytes=$1,finished=1 WHERE id=$2',bytes,lease) })
        })
        await this.event(auth,u,'download_allowed')
        return new Response(stream,{headers:{'content-type':'application/octet-stream','content-length':String(u.size)}})
      }
      throw new HttpError(404)
    }).catch(async error => {
      if (body && ((kind === 'transfer' && action === 'content') || (action === 'challenge' && body.action === 'download'))) {
        await auditDownloadDenied(this.db, { kind: 'team', orgId: org, requestId, actorId: auth.user_id }, error, this.clock())
      }
      throw error
    })
  }
}

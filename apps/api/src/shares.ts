import { limits } from './limits.ts'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Database } from './database.ts'
import { fields, HttpError, jsonBody } from './http.ts'
import { Objects } from './objects.ts'
import { auditDownloadDenied } from './download-audit.ts'

const DAY = 86_400_000
const hash = (value: string) => createHash('sha256').update(value).digest('base64url')
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new HttpError(400, 'invalid_input')
  return value
}
type Session = { user_id: string; token_hash: string }
type Share = { id: string; org_id: string; environment_id: string; creator_id: string; size: number; digest: string; retention_days: number; token_hash: string | null; status: string; created_at: number; write_until: number | null; ended_at: number | null; deleted_at: number | null; available_until: number | null; revoked_at: number | null; acknowledged_at: number | null }

// Called in the same transaction as permission/account mutations. Device changes do not affect shares.
export async function invalidateShares(db: Database, now: number) {
  await db.run(`UPDATE external_shares s SET revoked_at=$1,ended_at=$1,token_hash=NULL,
    status=CASE WHEN status='committed' THEN status ELSE 'cancelled' END
    WHERE ended_at IS NULL AND NOT EXISTS(SELECT 1 FROM effective_file_permissions p WHERE p.org_id=s.org_id AND p.environment_id=s.environment_id AND p.user_id=s.creator_id AND p.external_share=1)`, now)
  await db.run("UPDATE external_shares SET ended_at=available_until,token_hash=NULL WHERE ended_at IS NULL AND status='committed' AND available_until<=$1", now)
  await db.run("UPDATE external_shares SET status='failed',ended_at=$1,token_hash=NULL WHERE ended_at IS NULL AND status IN('reserved','writing') AND created_at<=$2", now, now-60*60_000)
}

export class Shares {
  private readonly db: Database
  private readonly objects?: Objects
  private readonly clock: () => number
  private readonly acceptNewTransfers: boolean
  private readonly beforePublicAccess: () => unknown
  // ponytail: single-process beta limiter; use a shared limiter before running multiple API instances.
  private readonly attempts = new Map<string, { count: number; until: number; denialAudited?: boolean }>()
  constructor(db: Database, root?: string, clock = Date.now, acceptNewTransfers = true, beforePublicAccess: () => unknown = () => {}) { this.beforePublicAccess = beforePublicAccess; this.db = db; this.clock = clock; this.acceptNewTransfers = acceptNewTransfers; if (root) this.objects = new Objects(root) }
  async prune() {
    await this.db.transaction(async () => {
      await invalidateShares(this.db, this.clock())
      await this.db.run('DELETE FROM share_download_leases WHERE day<$1', Math.floor(this.clock()/DAY)-2)
    })
    if (!this.objects) return
    const rows = await this.db.all<{ id: string }>('SELECT id FROM external_shares WHERE ended_at IS NOT NULL AND deleted_at IS NULL AND (write_until IS NULL OR write_until<=$1)', this.clock())
    for (const row of rows) {
      try {
        await this.objects.remove(row.id)
        await this.db.transaction(async () => { await this.db.run('UPDATE external_shares SET deleted_at=$1,token_hash=NULL WHERE id=$2 AND ended_at IS NOT NULL', this.clock(), row.id) })
      } catch {
        console.error('Encrypted share deletion failed')
        await this.db.run("INSERT INTO organization_events(org_id,target_id,event,created_at) SELECT org_id,id,'object_delete_failed',$1 FROM external_shares WHERE id=$2", this.clock(), row.id)
      }
    }
    await this.db.transaction(async () => { await this.db.run('DELETE FROM external_shares WHERE deleted_at IS NOT NULL AND ended_at<=$1', this.clock()-30*DAY) })
  }
  private state(s: Share) { return s.revoked_at !== null ? 'revoked' : s.available_until !== null && s.available_until <= this.clock() ? 'expired' : s.status === 'committed' ? 'available' : s.status }
  private summary(s: Share) {
    return { id:s.id, status:this.state(s), createdAt:s.created_at, expiresAt:s.available_until, acknowledgedAt:s.acknowledged_at,
      ...(s.ended_at === null ? { size:s.size, digest:s.digest } : {}) }
  }
  private async share(shareId: string, org?: string) {
    const s = await this.db.get<Share>('SELECT * FROM external_shares WHERE id=$1', shareId)
    if (!s || (org && s.org_id !== org)) throw new HttpError(404, 'share_unavailable')
    return s
  }
  private async permission(user: string, org: string, environment: string) {
    if (!await this.db.get('SELECT 1 FROM effective_file_permissions WHERE user_id=$1 AND org_id=$2 AND environment_id=$3 AND external_share=1', user, org, environment)) throw new HttpError(403, 'file_permission_required')
  }
  private async owner(user: string, org: string) {
    return !!await this.db.get("SELECT 1 FROM memberships m JOIN organizations o ON o.id=m.org_id AND o.active=1 WHERE m.user_id=$1 AND m.org_id=$2 AND m.role='owner'", user, org)
  }
  private async visible(user: string, s: Share) { if (user !== s.creator_id && !await this.owner(user,s.org_id)) throw new HttpError(404,'share_unavailable') }
  private async present(user: string, s: Share) {
    const base = { ...this.summary(s), canReissue:user===s.creator_id && this.state(s)==='available', canRevoke:s.ended_at===null }
    if (s.ended_at !== null) return base
    const names = await this.db.get('SELECT e.name AS environment,p.name AS project FROM environments e JOIN projects p ON p.id=e.project_id WHERE e.id=$1',s.environment_id)
    return { ...base, ...names, environmentId:s.environment_id, creatorId:s.creator_id }
  }
  private async current(session: () => Promise<Session>, auth: Session) {
    if ((await session()).token_hash !== auth.token_hash) throw new HttpError(401,'session_expired')
    await this.db.run('UPDATE sessions SET last_seen=$1 WHERE token_hash=$2',this.clock(),auth.token_hash)
    await invalidateShares(this.db,this.clock())
  }
  private async operation(user: string, operationId: string, input: unknown, apply: () => Promise<string>) {
    const inputHash = hash(JSON.stringify(input))
    const prior = await this.db.get<{ input_hash: string; share_id: string }>('SELECT input_hash,share_id FROM share_operations WHERE user_id=$1 AND operation_id=$2',user,operationId)
    if (prior) { if (prior.input_hash !== inputHash) throw new HttpError(409,'operation_conflict'); return prior.share_id }
    const shareId = await apply()
    await this.db.run('INSERT INTO share_operations VALUES($1,$2,$3,$4,$5)',user,operationId,shareId,inputHash,this.clock())
    return shareId
  }
  private async create(auth: Session, org: string, body: Record<string, unknown>) {
    fields(body,['operationId','environmentId','size','digest','retentionDays','tokenHash'])
    const shareId=id(body.operationId), environment=id(body.environmentId), size=body.size as number, days=body.retentionDays as number
    if (!Number.isSafeInteger(size) || size<40 || size>16*1024*1024 || ![1,3,7].includes(days) || !validHash(body.digest) || !validHash(body.tokenHash)) throw new HttpError(400,'invalid_upload')
    await this.permission(auth.user_id,org,environment)
    const selected = await this.operation(auth.user_id,shareId,[org,'create',environment,size,body.digest,days,body.tokenHash],async () => {
      if (!this.acceptNewTransfers) throw new HttpError(503, 'beta_closed')
      if (await this.db.get('SELECT 1 FROM stored_objects WHERE id=$1',shareId)) throw new HttpError(409,'operation_conflict')
      const quota=await this.db.get<{bytes:number;active:number}>("SELECT COALESCE(sum(size) FILTER(WHERE deleted_at IS NULL),0)::bigint AS bytes,count(*) FILTER(WHERE status IN('reserved','writing')) AS active FROM stored_objects WHERE org_id=$1",org)
      if (quota!.bytes+size>limits.organizationStorageBytes || quota!.active>=limits.concurrentUploads) throw new HttpError(429,'storage_limit')
      const recent=await this.db.get<{n:number}>('SELECT count(*) AS n FROM creation_attempts WHERE user_id=$1 AND created_at>$2',auth.user_id,this.clock()-limits.creationWindowMs)
      if (recent!.n>=limits.creationAttempts) throw new HttpError(429,'request_rate_limit')
      await this.db.run("INSERT INTO external_shares(id,org_id,environment_id,creator_id,size,digest,retention_days,token_hash,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9)",shareId,org,environment,auth.user_id,size,body.digest,days,body.tokenHash,this.clock())
      await this.event(auth.user_id,await this.share(shareId),'share_created')
      return shareId
    })
    return this.present(auth.user_id,await this.share(selected,org))
  }
  private async event(user: string | null, s: Share, event: string) {
    await this.db.run('INSERT INTO organization_events(org_id,actor_id,target_id,event,created_at) VALUES($1,$2,$3,$4,$5)',s.org_id,user,s.id,event,this.clock())
  }
  private async upload(request: Request, session: () => Promise<Session>, auth: Session, org: string, shareId: string) {
    if (request.headers.get('content-type')!=='application/octet-stream') throw new HttpError(415,'binary_required')
    const s=await this.db.transaction(async () => {
      await this.current(session,auth)
      const s=await this.share(shareId,org)
      if (s.creator_id!==auth.user_id) throw new HttpError(403,'creator_required')
      await this.permission(auth.user_id,org,s.environment_id)
      if (!this.acceptNewTransfers) throw new HttpError(503, 'beta_closed')
      if (s.status!=='reserved' || s.ended_at!==null) throw new HttpError(409,'upload_unavailable')
      await this.db.run("UPDATE external_shares SET status='writing',write_until=$1 WHERE id=$2",this.clock()+5*60_000,s.id)
      return s
    })
    try {
      await this.objects!.write(s.id,request.body,s.size,s.digest)
      return await this.db.transaction(async () => {
        await this.current(session,auth)
        const current=await this.share(s.id,org)
        await this.permission(auth.user_id,org,s.environment_id)
        if (current.status!=='writing' || current.ended_at!==null) throw new HttpError(409,'upload_unavailable')
        await this.db.run("UPDATE external_shares SET status='committed',available_until=$1,write_until=NULL WHERE id=$2",this.clock()+s.retention_days*DAY,s.id)
        await this.event(auth.user_id,s,'share_committed')
        return Response.json(await this.present(auth.user_id,await this.share(s.id)))
      })
    } catch (error) {
      await this.db.transaction(async () => { await this.db.run("UPDATE external_shares SET status=CASE WHEN status='writing' THEN 'failed' ELSE status END,ended_at=COALESCE(ended_at,$1),token_hash=NULL,write_until=NULL WHERE id=$2 AND status!='committed'",this.clock(),s.id) })
      throw error
    }
  }
  async handle(request: Request, session: () => Promise<Session>) {
    if (!this.objects) throw new HttpError(503,'storage_unavailable')
    const route=/^\/organizations\/([^/]+)\/shares(?:\/([^/]+))?(?:\/(content|reissue|revoke))?$/.exec(new URL(request.url).pathname)
    if (!route) throw new HttpError(404)
    const org=id(route[1]), shareId=route[2] ? id(route[2]) : undefined, action=route[3], auth=await session()
    if (!['GET','POST'].includes(request.method)) throw new HttpError(405)
    if (request.method==='POST' && shareId && action==='content') return this.upload(request,session,auth,org,shareId)
    const body=request.method==='POST' ? await jsonBody(request) : undefined
    return this.db.transaction(async () => {
      await this.current(session,auth)
      if (!shareId) {
        if (body) return Response.json(await this.create(auth,org,body))
        const owner=await this.owner(auth.user_id,org)
        const rows=await this.db.all<Share>('SELECT * FROM external_shares WHERE org_id=$1 AND ($2 OR creator_id=$3) ORDER BY created_at DESC,id',org,owner,auth.user_id)
        return Response.json({shares:await Promise.all(rows.map(s=>this.present(auth.user_id,s)))})
      }
      const s=await this.share(shareId,org); await this.visible(auth.user_id,s)
      if (!body && !action) return Response.json(await this.present(auth.user_id,s))
      if (!body || !action) throw new HttpError(404)
      fields(body,action==='reissue' ? ['operationId','tokenHash'] : ['operationId'])
      const operationId=id(body.operationId)
      if (action==='reissue') {
        if (s.creator_id!==auth.user_id) throw new HttpError(403,'creator_required')
        await this.permission(auth.user_id,org,s.environment_id)
        if (this.state(s)!=='available' || s.ended_at!==null) throw new HttpError(410,'share_unavailable')
        if (!validHash(body.tokenHash)) throw new HttpError(400,'invalid_input')
      } else if (action!=='revoke') throw new HttpError(404)
      await this.operation(auth.user_id,operationId,[org,shareId,action,body.tokenHash ?? null],async () => {
        if (action==='reissue') await this.db.run('UPDATE external_shares SET token_hash=$1 WHERE id=$2',body.tokenHash,s.id)
        else await this.db.run("UPDATE external_shares SET revoked_at=COALESCE(revoked_at,$1),ended_at=COALESCE(ended_at,$1),token_hash=NULL,status=CASE WHEN status IN('reserved','writing') THEN 'cancelled' ELSE status END WHERE id=$2",this.clock(),s.id)
        await this.event(auth.user_id,s,action==='reissue'?'share_link_reissued':'share_revoked')
        return s.id
      })
      const current=await this.share(s.id)
      if (action==='reissue' && current.token_hash!==body.tokenHash) throw new HttpError(409,'operation_conflict')
      return Response.json(await this.present(auth.user_id,current))
    })
  }
  async public(request: Request) {
    if (!this.objects) throw new HttpError(503,'storage_unavailable')
    const route=/^\/shares\/([^/]+)(?:\/(content|ack))?$/.exec(new URL(request.url).pathname)
    if (!route || !/^[0-9a-f-]{36}$/.test(route[1]!)) throw new HttpError(404,'share_unavailable')
    const shareId=route[1]!, action=route[2]
    if ((request.method==='GET' && action) || (request.method==='POST' && !action) || !['GET','POST'].includes(request.method)) throw new HttpError(404,'share_unavailable')
    const now=this.clock()
    for (const [key,value] of this.attempts) if (value.until<=now) this.attempts.delete(key)
    const attempt=this.attempts.get(shareId) ?? {count:0,until:now+60_000}
    if (attempt.count>=limits.shareRequestsPerMinute || (!this.attempts.has(shareId) && this.attempts.size>=1000)) {
      const error = new HttpError(429,'share_rate_limit')
      if (action==='content' && this.attempts.has(shareId) && !attempt.denialAudited) {
        attempt.denialAudited=true
        await auditDownloadDenied(this.db,{kind:'share',shareId},error,now)
      }
      throw error
    }
    attempt.count++;this.attempts.set(shareId,attempt)
    if (request.method==='POST') fields(await jsonBody(request),[])
    return this.db.transaction(async () => {
      await this.beforePublicAccess()
      await invalidateShares(this.db,now)
      const s=await this.share(shareId), token=request.headers.get('x-share-token')
      if (!validHash(token) || !s.token_hash || !timingSafeEqual(Buffer.from(hash(token)),Buffer.from(s.token_hash)) || s.ended_at!==null || this.state(s)!=='available') throw new HttpError(404,'share_unavailable')
      if (!action) return Response.json(this.summary(s))
      if (action==='ack') {
        if (s.acknowledged_at===null) {
          await this.db.run('UPDATE external_shares SET acknowledged_at=$1 WHERE id=$2',now,s.id)
          await this.event(null,s,'share_acknowledged')
        }
        return Response.json(this.summary(await this.share(s.id)))
      }
      const day=Math.floor(now/DAY)
      const quota=await this.db.get<{bytes:number;active:number}>(`SELECT COALESCE(sum(bytes) FILTER(WHERE org_id=$1 AND day=$2),0)::bigint AS bytes,
        count(*) FILTER(WHERE object_id=$3 AND finished=0 AND expires_at>$4) AS active FROM all_download_leases`,s.org_id,day,s.id,now)
      if (quota!.bytes+s.size>limits.organizationDailyDownloadBytes || quota!.active>=limits.concurrentDownloads) throw new HttpError(429,'download_limit')
      const lease=randomUUID()
      await this.db.run('INSERT INTO share_download_leases(id,share_id,org_id,day,bytes,expires_at) VALUES($1,$2,$3,$4,$5,$6)',lease,s.id,s.org_id,day,s.size,now+5*60_000)
      const stream=await this.objects!.read(s.id,s.size,async bytes=>{ await this.db.transaction(async()=>{ await this.db.run('UPDATE share_download_leases SET bytes=$1,finished=1 WHERE id=$2',bytes,lease) }) })
      await this.event(null,s,'share_download_allowed')
      return new Response(stream,{headers:{'content-type':'application/octet-stream','content-length':String(s.size)}})
    }).catch(async error => {
      if (action==='content') await auditDownloadDenied(this.db,{kind:'share',shareId},error,this.clock())
      throw error
    })
  }
}

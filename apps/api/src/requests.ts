import { limits } from './limits.ts'
import { invalidateShares } from './shares.ts'
import { invalidateTransfers } from './transfers.ts'
import { randomUUID } from 'node:crypto'
import type { Database } from './database.ts'
import type { Organizations } from './organizations.ts'
import { fields, HttpError, jsonBody } from './http.ts'

const DAY = 24 * 60 * 60_000
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new HttpError(400, 'invalid_input')
  return value
}
type Row = { id: string; org_id: string; environment_id: string; receiver_id: string; sender_id: string; receiver_device_id: string; status: string; created_at: number; expires_at: number; ended_at: number | null }

// Also called inside permission/device/account mutations, before their transaction commits.
export async function invalidateRequests(db: Database, now: number): Promise<void> {
  await db.transaction(async () => {
    await db.run("UPDATE file_requests SET status='expired',ended_at=$1 WHERE status IN ('pending','approved') AND expires_at <= $1", now)
    await db.run(`UPDATE file_requests r SET status='cancelled',ended_at=$1 WHERE status IN ('pending','approved') AND (
      NOT EXISTS(SELECT 1 FROM effective_file_permissions p WHERE p.org_id=r.org_id AND p.environment_id=r.environment_id AND p.user_id=r.receiver_id AND p.receive=1)
      OR NOT EXISTS(SELECT 1 FROM effective_file_permissions p WHERE p.org_id=r.org_id AND p.environment_id=r.environment_id AND p.user_id=r.sender_id AND p.send=1)
      OR NOT EXISTS(SELECT 1 FROM devices d WHERE d.id=r.receiver_device_id AND d.user_id=r.receiver_id AND d.status='active')
    )`, now)
    await invalidateTransfers(db, now)
    await invalidateShares(db, now)
  })
}

export class Requests {
  private readonly db: Database
  private readonly organizations: Organizations
  private readonly clock: () => number
  private readonly acceptNewTransfers: boolean
  constructor(db: Database, organizations: Organizations, clock = Date.now, acceptNewTransfers = true) {
    this.db = db; this.organizations = organizations; this.clock = clock; this.acceptNewTransfers = acceptNewTransfers
  }

  async prune(): Promise<void> {
    await this.db.transaction(async () => {
      await invalidateRequests(this.db, this.clock())
      await this.db.run('DELETE FROM file_requests r WHERE ended_at <= $1 AND NOT EXISTS(SELECT 1 FROM uploads u WHERE u.request_id=r.id)', this.clock() - 30 * DAY)
    })
  }
  private async owner(userId: string, orgId: string): Promise<boolean> {
    return !!await this.db.get("SELECT 1 FROM memberships m JOIN organizations o ON o.id=m.org_id WHERE m.org_id=$1 AND m.user_id=$2 AND m.role='owner' AND o.active=1", orgId, userId)
  }
  private async visible(userId: string, row: Row): Promise<void> {
    if (row.receiver_id !== userId && row.sender_id !== userId && !await this.owner(userId, row.org_id)) throw new HttpError(404, 'request_unavailable')
  }
  private async present(userId: string, row: Row) {
    const transfer = await this.db.get('SELECT id,available_until AS "expiresAt",acknowledged_at AS "acknowledgedAt",CASE WHEN revoked_at IS NOT NULL THEN \'revoked\' WHEN available_until<=$2 THEN \'expired\' ELSE \'available\' END AS status FROM uploads WHERE request_id=$1 AND status=\'committed\'', row.id, this.clock())
    const base = { ...(transfer ? { transfer } : {}), id: row.id, status: row.status, createdAt: row.created_at, expiresAt: row.expires_at,
      direction: row.receiver_id === userId ? 'outgoing' : row.sender_id === userId ? 'incoming' : 'managed' }
    // Closed requests expose only a minimal receipt, even after removal from the organization.
    if (!['pending', 'approved'].includes(row.status)) return base
    await this.organizations.membership(userId, row.org_id)
    const names = await this.db.get(`SELECT e.name AS environment,p.name AS project,
      sender.login AS sender,receiver.login AS receiver FROM environments e JOIN projects p ON p.id=e.project_id
      JOIN users sender ON sender.id=$2 JOIN users receiver ON receiver.id=$3 WHERE e.id=$1 AND p.org_id=$4`, row.environment_id, row.sender_id, row.receiver_id, row.org_id)
    return { ...base, ...names, environmentId: row.environment_id, receiverDeviceId: row.receiver_device_id }
  }
  private async options(userId: string, orgId: string, environmentId: string) {
    await this.organizations.requireFilePermission(userId, orgId, environmentId, 'receive')
    const senders = await this.db.all(`SELECT u.id,u.login FROM effective_file_permissions p JOIN users u ON u.id=p.user_id
      WHERE p.org_id=$1 AND p.environment_id=$2 AND p.send=1 AND u.id!=$3 ORDER BY u.login,u.id`, orgId, environmentId, userId)
    return { senders }
  }
  private async remember(userId: string, operationId: string, requestId: string, input: string, status: string) {
    const result = { id: requestId, status }
    await this.db.run('INSERT INTO request_operations VALUES ($1,$2,$3,$4,$5,$6)', userId, operationId, requestId, input, JSON.stringify(result), this.clock())
    await this.db.run('INSERT INTO organization_events (org_id,actor_id,target_id,event,created_at) SELECT org_id,$1,id,$2,$3 FROM file_requests WHERE id=$4', userId, 'request_' + status, this.clock(), requestId)
    return result
  }
  private async replay(userId: string, operationId: string, input: string) {
    const prior = await this.db.get<{ input: string; result: string }>('SELECT input,result FROM request_operations WHERE user_id=$1 AND operation_id=$2', userId, operationId)
    if (!prior) return undefined
    if (prior.input !== input) throw new HttpError(409, 'operation_conflict')
    return JSON.parse(prior.result) as { id: string; status: string }
  }
  private async create(userId: string, orgId: string, body: Record<string, unknown>) {
    fields(body, ['operationId', 'environmentId', 'senderId', 'deviceId'])
    const operationId = id(body.operationId), environmentId = id(body.environmentId), senderId = id(body.senderId), deviceId = id(body.deviceId)
    if (senderId === userId) throw new HttpError(400, 'invalid_sender')
    const { senders } = await this.options(userId, orgId, environmentId)
    if (!senders.some(sender => sender.id === senderId)) throw new HttpError(403, 'sender_unavailable')
    if (!await this.db.get("SELECT 1 FROM devices WHERE id=$1 AND user_id=$2 AND status='active'", deviceId, userId)) throw new HttpError(403, 'device_required')
    const input = JSON.stringify([orgId, 'create', environmentId, senderId, deviceId])
    const prior = await this.replay(userId, operationId, input)
    if (prior) return prior
    if (!this.acceptNewTransfers) throw new HttpError(503, 'beta_closed')
    const count = await this.db.get<{ n: number }>("SELECT count(*) AS n FROM file_requests WHERE org_id=$1 AND status IN ('pending','approved')", orgId)
    if (count!.n >= limits.pendingRequests) throw new HttpError(429, 'request_limit')
    const recent = await this.db.get<{ n: number }>('SELECT count(*) AS n FROM creation_attempts WHERE user_id=$1 AND created_at>$2', userId, this.clock() - limits.creationWindowMs)
    if (recent!.n >= limits.creationAttempts) throw new HttpError(429, 'request_rate_limit')
    const requestId = randomUUID(), now = this.clock()
    await this.db.run("INSERT INTO file_requests VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,NULL)", requestId, orgId, environmentId, userId, senderId, deviceId, now, now + 7 * DAY)
    return this.remember(userId, operationId, requestId, input, 'pending')
  }
  private async change(userId: string, row: Row, action: string, body: Record<string, unknown>) {
    fields(body, ['operationId'])
    const operationId = id(body.operationId)
    if (!['approve', 'reject', 'cancel'].includes(action)) throw new HttpError(404)
    if (action !== 'cancel') {
      if (userId !== row.sender_id) throw new HttpError(403, 'sender_required')
      await this.organizations.requireFilePermission(userId, row.org_id, row.environment_id, 'send')
    }
    const input = JSON.stringify([row.org_id, row.id, action])
    const prior = await this.replay(userId, operationId, input)
    if (prior) return prior
    if (!['pending', 'approved'].includes(row.status) || (action !== 'cancel' && row.status !== 'pending')) throw new HttpError(409, 'request_closed')
    const status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled'
    await this.db.run('UPDATE file_requests SET status=$1,ended_at=$2 WHERE id=$3', status, status === 'approved' ? null : this.clock(), row.id)
    await invalidateTransfers(this.db, this.clock())
    return this.remember(userId, operationId, row.id, input, status)
  }
  async handle(request: Request, session: () => Promise<{ user_id: string; token_hash: string }>) {
    const auth = await session(), url = new URL(request.url)
    const match = /^\/organizations\/([^/]+)\/requests(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(url.pathname)
    if (!match) throw new HttpError(404)
    const orgId = id(match[1]), resource = match[2], action = match[3]
    if (!['GET', 'POST'].includes(request.method)) throw new HttpError(405)
    const body = request.method === 'POST' ? await jsonBody(request) : undefined
    return this.db.transaction(async () => {
      if ((await session()).token_hash !== auth.token_hash) throw new HttpError(401, 'session_expired')
      await this.db.run('UPDATE sessions SET last_seen=$1 WHERE token_hash=$2', this.clock(), auth.token_hash)
      await invalidateRequests(this.db, this.clock())
      if (!resource && body) return this.create(auth.user_id, orgId, body)
      if (resource === 'options' && !action && !body) return this.options(auth.user_id, orgId, id(url.searchParams.get('environmentId')))
      if (!resource && !body) {
        // ponytail: show the latest 100 with open requests first; add pagination when beta history needs it.
        const rows = await this.db.all<Row>(`SELECT * FROM file_requests WHERE org_id=$1 AND (receiver_id=$2 OR sender_id=$2 OR $3)
          ORDER BY (status IN ('pending','approved')) DESC,created_at DESC,id DESC LIMIT 100`, orgId, auth.user_id, await this.owner(auth.user_id, orgId))
        return { requests: await Promise.all(rows.map(row => this.present(auth.user_id, row))) }
      }
      const row = await this.db.get<Row>('SELECT * FROM file_requests WHERE id=$1 AND org_id=$2', id(resource), orgId)
      if (!row) throw new HttpError(404, 'request_unavailable')
      await this.visible(auth.user_id, row)
      if (!body && !action) return this.present(auth.user_id, row)
      if (body && action) return this.change(auth.user_id, row, action, body)
      throw new HttpError(404)
    })
  }
}

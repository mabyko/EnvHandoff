import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Database } from './database.ts'
import { HttpError } from './http.ts'
import { limits } from './limits.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export class Beta {
  private readonly db: Database
  private readonly clock: () => number
  private readonly operatorId: string
  constructor(db: Database, clock = Date.now, operatorId = '') {
    this.db = db; this.clock = clock; this.operatorId = operatorId
    if (operatorId && !/^[1-9][0-9]{0,15}$/.test(operatorId)) throw new Error('Invalid PRO_OPERATOR_GITHUB_ID')
  }
  async status(userId: string) {
    const user = await this.db.get('SELECT github_id FROM users WHERE id=$1 AND disabled=0', userId)
    if (!user) throw new HttpError(401, 'session_expired')
    const operator = user.github_id === this.operatorId
    const active = operator || !!await this.db.get('SELECT 1 FROM beta_members WHERE user_id=$1', userId)
    const owned = (await this.db.get("SELECT count(*) AS n FROM memberships m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=$1 AND m.role='owner'", userId))!.n as number
    return { operator, active, owned, workspaceLimit: limits.ownedOrganizations }
  }
  async requireOperator(userId: string) {
    if (!(await this.status(userId)).operator) throw new HttpError(403, 'operator_required')
  }
  async requireCreation(userId: string) {
    if (!(await this.status(userId)).active) throw new HttpError(403, 'beta_required')
    await this.requireCapacity(userId)
  }
  async requireCapacity(userId: string) {
    if ((await this.status(userId)).owned >= limits.ownedOrganizations) throw new HttpError(409, 'workspace_limit')
  }
  // Commit failed attempts too; callers must invoke this before the redemption transaction.
  async attempt(userId: string) {
    await this.db.transaction(async () => {
      await this.status(userId)
      const count = (await this.db.get("SELECT count(*) AS n FROM auth_events WHERE user_id=$1 AND event='beta_attempt' AND created_at>$2", userId, this.clock() - limits.creationWindowMs))!.n as number
      if (count >= limits.creationAttempts) throw new HttpError(429, 'beta_attempt_limit')
      await this.db.run("INSERT INTO auth_events(user_id,event,created_at) VALUES($1,'beta_attempt',$2)", userId, this.clock())
    })
  }
  async redeem(userId: string, value: unknown) {
    return this.db.transaction(async () => {
      const status = await this.status(userId)
      if (status.active) return status
      const code = typeof value === 'string' ? value.trim().toUpperCase().replaceAll('-', '') : ''
      if (!/^[0-9A-F]{32}$/.test(code)) throw new HttpError(400, 'beta_code_unavailable')
      const row = await this.db.get('SELECT id FROM beta_codes WHERE code_hash=$1 AND revoked=0 AND expires_at>$2 AND used<max_uses', hash(code), this.clock())
      if (!row) throw new HttpError(410, 'beta_code_unavailable')
      await this.db.run('INSERT INTO beta_members VALUES($1,$2,$3)', userId, this.clock(), row.id)
      await this.db.run('UPDATE beta_codes SET used=used+1 WHERE id=$1', row.id)
      await this.db.run("INSERT INTO auth_events(user_id,event,created_at) VALUES($1,'beta_activated',$2)", userId, this.clock())
      return this.status(userId)
    })
  }
  async codes(userId: string) {
    await this.requireOperator(userId)
    return this.db.all('SELECT id,label,max_uses AS "maxUses",used,created_at AS "createdAt",expires_at AS "expiresAt",revoked FROM beta_codes ORDER BY created_at DESC,id')
  }
  async issue(userId: string, label: unknown, maxUses: unknown, days: unknown) {
    return this.db.transaction(async () => {
      await this.requireOperator(userId)
      if (typeof label !== 'string' || !label.trim() || label.trim().length > 80 || /[\p{Cc}\p{Cf}]/u.test(label) ||
        typeof maxUses !== 'number' || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000 ||
        typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, 'invalid_beta_code')
      const pending = (await this.db.get('SELECT count(*) AS n FROM beta_codes WHERE revoked=0 AND expires_at>$1 AND used<max_uses', this.clock()))!.n as number
      if (pending >= 100) throw new HttpError(429, 'beta_code_limit')
      const raw = randomBytes(16).toString('hex').toUpperCase(), id = randomUUID(), now = this.clock()
      await this.db.run('INSERT INTO beta_codes(id,code_hash,label,max_uses,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)', id, hash(raw), label.trim(), maxUses, now, now + days * 86400000)
      await this.db.run("INSERT INTO auth_events(user_id,event,created_at) VALUES($1,'beta_code_issued',$2)", userId, now)
      return { id, code: raw.match(/.{4}/g)!.join('-') }
    })
  }
  async revoke(userId: string, id: unknown) {
    await this.requireOperator(userId)
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, 'invalid_input')
    if (!(await this.db.run('UPDATE beta_codes SET revoked=1 WHERE id=$1', id)).changes) throw new HttpError(404, 'beta_code_unavailable')
    await this.db.run("INSERT INTO auth_events(user_id,event,created_at) VALUES($1,'beta_code_revoked',$2)", userId, this.clock())
    return { ok: true }
  }
}

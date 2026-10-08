import type { Database } from './database.ts'

export type InvalidationScope = { organizationId: string } | { userId: string } | { requestId: string } | { shareId: string }

// SQL fragments here are fixed internal identifiers; scope values are always bound.
async function runScoped(db: Database, scope: InvalidationScope | undefined, entity: 'request' | 'transfer' | 'share', sql: string, ...values: (string | number)[]) {
  if (!scope) return db.run(sql, ...values)
  const alias = { request: 'r', transfer: 'u', share: 's' }[entity]
  const parameter = '$' + (values.length + 1)
  let condition: string, value: string
  if ('organizationId' in scope) {
    condition = `${alias}.org_id=${parameter}`; value = scope.organizationId
  } else if ('userId' in scope) {
    condition = entity === 'request' ? `(r.receiver_id=${parameter} OR r.sender_id=${parameter})`
      : entity === 'transfer' ? `(u.sender_id=${parameter} OR EXISTS(SELECT 1 FROM file_requests scoped_request WHERE scoped_request.id=u.request_id AND scoped_request.receiver_id=${parameter}))`
      : `s.creator_id=${parameter}`
    value = scope.userId
  } else if ('requestId' in scope) {
    if (entity === 'share') return
    condition = entity === 'request' ? `r.id=${parameter}` : `u.request_id=${parameter}`; value = scope.requestId
  } else {
    if (entity !== 'share') return
    condition = `s.id=${parameter}`; value = scope.shareId
  }
  return db.run(`${sql} AND (${condition})`, ...values, value)
}

// Mutations run these transitions in their transaction. No scope means the
// periodic maintenance pass; normal handlers touch only their affected scope.
export async function invalidateRequests(db: Database, now: number, scope?: InvalidationScope): Promise<void> {
  await db.transaction(async () => {
    await runScoped(db, scope, 'request', "UPDATE file_requests r SET status='expired',ended_at=$1 WHERE status IN ('pending','approved') AND expires_at <= $1", now)
    await runScoped(db, scope, 'request', `UPDATE file_requests r SET status='cancelled',ended_at=$1 WHERE status IN ('pending','approved') AND (
      NOT EXISTS(SELECT 1 FROM effective_file_permissions p WHERE p.org_id=r.org_id AND p.environment_id=r.environment_id AND p.user_id=r.receiver_id AND p.receive=1)
      OR NOT EXISTS(SELECT 1 FROM effective_file_permissions p WHERE p.org_id=r.org_id AND p.environment_id=r.environment_id AND p.user_id=r.sender_id AND p.send=1)
      OR NOT EXISTS(SELECT 1 FROM devices d WHERE d.id=r.receiver_device_id AND d.user_id=r.receiver_id AND d.status='active')
    )`, now)
    await invalidateTransfers(db, now, scope)
    await invalidateShares(db, now, scope)
  })
}

export async function invalidateTransfers(db: Database, now: number, scope?: InvalidationScope) {
  await runScoped(db, scope, 'transfer', `UPDATE uploads u SET revoked_at=$1,ended_at=$1 WHERE status='committed' AND ended_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM file_requests r
    JOIN effective_file_permissions rp ON rp.org_id=r.org_id AND rp.environment_id=r.environment_id AND rp.user_id=r.receiver_id AND rp.receive=1
    JOIN effective_file_permissions sp ON sp.org_id=r.org_id AND sp.environment_id=r.environment_id AND sp.user_id=r.sender_id AND sp.send=1
    JOIN devices rd ON rd.id=r.receiver_device_id AND rd.user_id=r.receiver_id AND rd.status='active'
    JOIN devices sd ON sd.id=u.sender_device_id AND sd.user_id=r.sender_id AND sd.status='active'
    WHERE r.id=u.request_id
  )`, now)
  await runScoped(db, scope, 'transfer', "UPDATE uploads u SET ended_at=available_until WHERE status='committed' AND ended_at IS NULL AND available_until <= $1", now)
  await runScoped(db, scope, 'transfer', `UPDATE uploads u SET status='cancelled',ended_at=$1 WHERE status IN ('reserved','writing') AND (
    NOT EXISTS(SELECT 1 FROM file_requests r WHERE r.id=u.request_id AND r.status='approved')
    OR NOT EXISTS(SELECT 1 FROM devices d WHERE d.id=u.sender_device_id AND d.user_id=u.sender_id AND d.status='active'))`, now)
  await runScoped(db, scope, 'transfer', "UPDATE uploads u SET status='failed',ended_at=$1 WHERE status IN ('reserved','writing') AND created_at <= $2", now, now - 60 * 60_000)
  await runScoped(db, scope, 'request', "UPDATE file_requests r SET ended_at=u.ended_at FROM uploads u WHERE u.request_id=r.id AND u.status='committed' AND r.status='fulfilled' AND u.ended_at IS NOT NULL AND r.ended_at IS NULL")
}

export async function invalidateShares(db: Database, now: number, scope?: InvalidationScope) {
  await runScoped(db, scope, 'share', `UPDATE external_shares s SET revoked_at=$1,ended_at=$1,token_hash=NULL,
    status=CASE WHEN status='committed' THEN status ELSE 'cancelled' END
    WHERE ended_at IS NULL AND NOT EXISTS(SELECT 1 FROM effective_file_permissions p WHERE p.org_id=s.org_id AND p.environment_id=s.environment_id AND p.user_id=s.creator_id AND p.external_share=1)`, now)
  await runScoped(db, scope, 'share', "UPDATE external_shares s SET ended_at=available_until,token_hash=NULL WHERE ended_at IS NULL AND status='committed' AND available_until<=$1", now)
  await runScoped(db, scope, 'share', "UPDATE external_shares s SET status='failed',ended_at=$1,token_hash=NULL WHERE ended_at IS NULL AND status IN('reserved','writing') AND created_at<=$2", now, now-60*60_000)
}

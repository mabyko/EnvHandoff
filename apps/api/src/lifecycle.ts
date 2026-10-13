import type { Database } from './database.ts'
import { randomUUID } from 'node:crypto'

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
    await invalidatePublications(db, now, scope)
  })
}

// Published files belong to the team. Losing the publisher's access cancels
// pending writes but does not erase a committed snapshot or other recipients.
export async function invalidatePublications(db: Database, now: number, scope?: InvalidationScope) {
  if (scope && !('organizationId' in scope) && !('userId' in scope)) return
  const organization = scope && 'organizationId' in scope ? scope.organizationId : undefined
  const subject = scope && 'userId' in scope ? scope.userId : undefined
  const filter = organization ? ' AND v.org_id=$2' : subject ? ' AND v.publisher_user_id=$2' : ''
  const values = organization ? [now, organization] : subject ? [now, subject] : [now]
  await db.run(`UPDATE environment_versions v SET status='cancelled',ended_at=$1,end_reason='access_revoked'
    WHERE ended_at IS NULL AND status IN('reserved','writing') AND NOT EXISTS(
      SELECT 1 FROM effective_file_permissions p JOIN devices d ON d.user_id=p.user_id
      WHERE p.org_id=v.org_id AND p.environment_id=v.environment_id AND p.user_id=v.publisher_user_id
      AND p.receive=1 AND p.send=1 AND d.id=v.publisher_device_id AND d.status='active')${filter}`, ...values)
  await db.run(`UPDATE environment_versions v SET status='failed',ended_at=$1,end_reason='upload_expired'
    WHERE ended_at IS NULL AND status IN('reserved','writing') AND created_at<=$1::bigint-3600000${filter}`, ...values)
  if (!subject) await db.run(`UPDATE environment_versions v SET ended_at=$1,end_reason='environment_deleted',
    status=CASE WHEN status IN('reserved','writing') THEN 'cancelled' ELSE status END
    WHERE ended_at IS NULL AND NOT EXISTS(SELECT 1 FROM environments e JOIN projects p ON p.id=e.project_id
      JOIN organizations o ON o.id=p.org_id AND o.active=1 WHERE e.id=v.environment_id AND p.org_id=v.org_id)${filter}`, ...values)
  const heads = await db.all<{ environment_id: string }>(`SELECT h.environment_id FROM environment_publication_heads h
    JOIN environment_versions v ON v.id=h.version_id WHERE v.ended_at IS NOT NULL${organization ? ' AND v.org_id=$1' : subject ? ' AND v.publisher_user_id=$1' : ''}`, ...(organization ? [organization] : subject ? [subject] : []))
  for (const head of heads) await db.run(`UPDATE environment_publication_heads h SET generation=$1,version_id=NULL,
    end_reason=(SELECT end_reason FROM environment_versions WHERE id=h.version_id) WHERE environment_id=$2`, randomUUID(), head.environment_id)
  await db.run(`DELETE FROM environment_key_wraps w USING environment_versions v WHERE w.version_id=v.id
    AND (v.ended_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM effective_file_permissions p JOIN devices d ON d.user_id=p.user_id
      WHERE p.org_id=v.org_id AND p.environment_id=v.environment_id AND p.user_id=w.recipient_user_id AND p.receive=1
      AND d.id=w.recipient_device_id AND d.status='active'))${organization ? ' AND v.org_id=$1' : subject ? ' AND w.recipient_user_id=$1' : ''}`, ...(organization ? [organization] : subject ? [subject] : []))
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

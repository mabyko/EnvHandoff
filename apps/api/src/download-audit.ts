import type { Database } from './database.ts'
import { HttpError } from './http.ts'

type Target = { kind: 'team'; orgId: string; requestId: string; actorId: string } | { kind: 'share'; shareId: string }

// Call after the rejected operation rolls back. Neither error messages nor request secrets are stored.
export async function auditDownloadDenied(db: Database, target: Target, error: unknown, now: number): Promise<void> {
  if (!(error instanceof HttpError) || ![400, 401, 403, 404, 409, 410, 429].includes(error.status)) return
  try {
    await db.transaction(async () => {
      const row = target.kind === 'team'
        ? await db.get<{ id: string; org_id: string }>("SELECT id,org_id FROM uploads WHERE org_id=$1 AND request_id=$2 AND status='committed'", target.orgId, target.requestId)
        : await db.get<{ id: string; org_id: string }>("SELECT id,org_id FROM external_shares WHERE id=$1 AND status='committed'", target.shareId)
      if (!row) return
      const event = target.kind === 'team' ? 'download_denied' : 'share_download_denied'
      // Existing request limiters bound attempts; persist only the first denial per object/minute across API instances.
      // This is a sampled denial audit, not an attempt counter or a reason breakdown; later actors in the window are omitted.
      await db.run(`INSERT INTO organization_events(org_id,actor_id,target_id,event,created_at)
        SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS(
          SELECT 1 FROM organization_events WHERE target_id=$3 AND event=$4 AND created_at>$6)`,
        row.org_id, target.kind === 'team' ? target.actorId : null, row.id, event, now, now - 60_000)
    })
  } catch {
    // The original denial remains opaque and fail-closed even when the audit store is unavailable.
    console.error('Download denial audit failed')
  }
}

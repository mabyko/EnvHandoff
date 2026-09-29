import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from './database.ts'
import { Deletions } from './deletions.ts'

// Run with the API stopped after disaster recovery, before admitting traffic.
// Ordinary process restarts must not discard valid deliveries.
export async function blockRestoredTransfers(db: Database, apply = false, now = Date.now()) {
  return db.transaction(async () => {
    const counts = await db.get<{ requests: number; transfers: number; shares: number }>(`SELECT
      (SELECT count(*) FROM file_requests WHERE status IN ('pending','approved')) AS requests,
      (SELECT count(*) FROM uploads WHERE ended_at IS NULL) AS transfers,
      (SELECT count(*) FROM external_shares WHERE ended_at IS NULL) AS shares`)
    // The count preview reads operational metadata even when no deliveries need to change.
    await db.run(`INSERT INTO organization_events(org_id,target_id,event,created_at)
      SELECT id,id,$1,$2::bigint FROM organizations
      UNION ALL SELECT NULL,'restore-safe',$1,$2::bigint WHERE NOT EXISTS(SELECT 1 FROM organizations)`,
    apply ? 'restored_transfers_apply_checked' : 'restored_transfers_previewed', now)
    if (!apply) return { applied: false, auditRecorded: true, ...counts! }
    await db.run("UPDATE file_requests SET status='cancelled',ended_at=$1 WHERE status IN ('pending','approved')", now)
    for (const table of ['uploads', 'external_shares']) {
      await db.run(`UPDATE ${table} SET
        status=CASE WHEN status IN ('reserved','writing') THEN 'cancelled' ELSE status END,
        revoked_at=COALESCE(revoked_at,$1),ended_at=COALESCE(ended_at,$1),write_until=NULL
        WHERE ended_at IS NULL`, now)
    }
    await db.run('UPDATE external_shares SET token_hash=NULL')
    await db.run('DELETE FROM share_operations')
    await db.run('DELETE FROM transfer_challenges')
    if (counts!.requests + counts!.transfers + counts!.shares > 0) {
      await db.run(`INSERT INTO organization_events(org_id,target_id,event,created_at)
        SELECT id,id,'restored_transfers_blocked',$1 FROM organizations`, now)
    }
    return { applied: true, auditRecorded: true, ...counts! }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let db: Database | undefined
  try {
    const args = process.argv.slice(2)
    if (args.length === 1 && args[0] === '--help') {
      console.log(`Usage: restore-safe [--apply]
Run after disaster recovery with the API stopped and migrations complete.
Without --apply, transfer state is preserved; metadata-read audit events are still recorded.
--apply blocks restored deliveries. Every invocation, including retries with zero counts, records an audit event.
Mandatory deletion-ledger enforcement runs before either mode and may reapply previously requested deletions.
Successful output includes auditRecorded:true. DATABASE_URL and DELETION_LEDGER_PATH are required.`)
    } else {
      if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) throw new Error('Invalid arguments')
      if (!process.env.DELETION_LEDGER_PATH) throw new Error('Deletion ledger required')
      db = new Database(process.env.DATABASE_URL ?? '')
      const ledger = new Deletions(process.env.DELETION_LEDGER_PATH)
      const database = db
      const result = await database.transaction(async () => {
        // Deletion records precede the preview under the same lock as its metadata read.
        const deletions = await ledger.sync(database)
        return { ...(await blockRestoredTransfers(database, args[0] === '--apply')), deletions }
      })
      console.log(JSON.stringify(result))
    }
  } catch {
    console.error('Restore protection failed. Keep the API stopped. Check DATABASE_URL, DELETION_LEDGER_PATH, migrations, and usage: restore-safe [--apply].')
    process.exitCode = 1
  } finally { await db?.close() }
}

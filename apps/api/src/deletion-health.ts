import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from './database.ts'

type AgeSummary = { count: number; oldestAgeMs: number | null }
type ObjectHealth = { stalledUploads: AgeSummary; overdueDeletions: AgeSummary }
export type DeletionHealth = { status: 'ok' | 'delayed'; checkedAt: number; uploads: ObjectHealth; externalShares: ObjectHealth }

// Observation only: do not migrate, sync the deletion ledger, end uploads or alter writer leases.
// A live writer may defer removal, but cannot exempt an object from the deletion deadline.
export async function deletionHealth(db: Database, now = Date.now()): Promise<DeletionHealth> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid observation time')
  const rows = await db.all<{ kind: 'uploads' | 'externalShares'; phase: keyof ObjectHealth; count: number; oldest: number }>(`
    WITH objects AS (
      SELECT 'uploads' AS kind,status,created_at,ended_at,deleted_at FROM uploads
      UNION ALL
      SELECT 'externalShares',status,created_at,ended_at,deleted_at FROM external_shares
    ), delayed AS (
      SELECT kind,'stalledUploads' AS phase,created_at AS started_at FROM objects
      WHERE ended_at IS NULL AND status IN ('reserved','writing') AND created_at <= $1
      UNION ALL
      SELECT kind,'overdueDeletions',ended_at FROM objects
      WHERE ended_at <= $2 AND deleted_at IS NULL
    )
    SELECT kind,phase,count(*) AS count,min(started_at) AS oldest FROM delayed GROUP BY kind,phase`,
  now - 3_600_000, now - 86_400_000)
  const empty = (): ObjectHealth => ({ stalledUploads: { count: 0, oldestAgeMs: null }, overdueDeletions: { count: 0, oldestAgeMs: null } })
  const result: DeletionHealth = { status: rows.length ? 'delayed' : 'ok', checkedAt: now, uploads: empty(), externalShares: empty() }
  for (const row of rows) result[row.kind][row.phase] = { count: row.count, oldestAgeMs: now - row.oldest }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let db: Database | undefined
  try {
    const args = process.argv.slice(2)
    if (args.length === 1 && args[0] === '--help') {
      console.log('Usage: deletion-health [--help]\nRequires DATABASE_URL and an already migrated database. Read-only; DELETION_LEDGER_PATH is not required.\nPrints aggregate JSON only. Exit codes: 0 healthy, 1 delayed, 2 check failed.')
    } else {
      if (args.length) throw new Error('Invalid arguments')
      db = new Database(process.env.DATABASE_URL ?? '')
      const health = await deletionHealth(db)
      console.log(JSON.stringify(health))
      process.exitCode = health.status === 'ok' ? 0 : 1
    }
  } catch {
    console.error('Deletion health check failed. Check DATABASE_URL, migrations and usage: deletion-health [--help].')
    process.exitCode = 2
  } finally { await db?.close() }
}

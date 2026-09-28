import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from './database.ts'
import { Deletions } from './deletions.ts'
import { invalidateRequests } from './requests.ts'

function userId(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error('invalid_user_id')
  return value
}

// Shared by the operator CLI and the existing internal API entry point.
export async function disableUser(db: Database, id: string, now = Date.now()): Promise<void> {
  userId(id)
  await db.transaction(async () => {
    if (!await db.get('SELECT 1 FROM users WHERE id=$1', id)) throw new Error('account_unavailable')
    await db.run('UPDATE users SET disabled=1 WHERE id=$1', id)
    await db.run('DELETE FROM oauth_flows WHERE previous_session IN (SELECT token_hash FROM sessions WHERE user_id=$1)', id)
    await db.run('DELETE FROM sessions WHERE user_id=$1', id)
    await db.run("UPDATE invitations SET status='cancelled' WHERE status='pending' AND (issuer_id=$1 OR target_id=(SELECT github_id FROM users WHERE id=$1))", id)
    await invalidateRequests(db, now)
    await db.run("INSERT INTO auth_events(user_id,event,created_at) VALUES($1,'account_disabled',$2)", id, now)
  })
}

export async function disableAccount(db: Database, ledger: Deletions, id: string, githubId: string, apply = false, now = Date.now()) {
  userId(id)
  if (!/^[1-9][0-9]{0,19}$/.test(githubId)) throw new Error('invalid_github_id')
  return db.transaction(async () => {
    await ledger.sync(db, now)
    const account = await db.get<{ disabled: number }>('SELECT disabled FROM users WHERE id=$1 AND github_id=$2', id, githubId)
    if (!account) throw new Error('account_identity_mismatch')
    const counts = await db.get<{ sessions: number; organizations: number }>(`SELECT
      (SELECT count(*) FROM sessions WHERE user_id=$1) AS sessions,
      (SELECT count(*) FROM memberships WHERE user_id=$1) AS organizations`, id)
    if (apply) await disableUser(db, id, now)
    else await db.run("INSERT INTO auth_events(user_id,event,created_at) VALUES($1,'account_disable_previewed',$2)", id, now)
    return { applied: apply, auditRecorded: true, userId: id, githubId, wasDisabled: account.disabled === 1, ...counts! }
  })
}

const usage = `Operator-only emergency account suspension; no messages are sent.
  disable-account <internal-user-UUID> <numeric-GitHub-ID> [--apply]
Both IDs must match the same existing account. Default is a preview with a metadata-read audit.
--apply disables the account, invalidates all its sessions and pending invitations, and closes affected transfers.
The last Owner may be suspended in an emergency; use management-recovery for a replacement Owner.
It does not delete the account, reset keys, enable accounts or restore earlier transfers.
DATABASE_URL and DELETION_LEDGER_PATH are required. Migrations and permanent deletions are enforced even during preview.`

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--help') console.log(usage)
  else {
    let db: Database | undefined
    try {
      const args = process.argv.slice(2)
      if (args.length < 2 || args.length > 3 || (args.length === 3 && args[2] !== '--apply')) throw new Error('invalid_arguments')
      userId(args[0]!); if (!/^[1-9][0-9]{0,19}$/.test(args[1]!)) throw new Error('invalid_github_id')
      if (!process.env.DELETION_LEDGER_PATH) throw new Error('deletion_ledger_required')
      db = new Database(process.env.DATABASE_URL ?? '')
      await db.migrate()
      console.log(JSON.stringify(await disableAccount(db, new Deletions(process.env.DELETION_LEDGER_PATH), args[0]!, args[1]!, args[2] === '--apply')))
    } catch (error) {
      const safe = new Set(['invalid_arguments', 'invalid_user_id', 'invalid_github_id', 'account_identity_mismatch', 'deletion_ledger_required'])
      console.error(error instanceof Error && safe.has(error.message) ? error.message : 'account_suspension_failed')
      console.error('No suspension completion is confirmed. Check the target IDs and current state; use --help for usage.')
      process.exitCode = 1
    } finally { await db?.close() }
  }
}

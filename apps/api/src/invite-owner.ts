import { Database } from './database.ts'
import { Deletions } from './deletions.ts'
import { githubAccount, Organizations } from './organizations.ts'

const login = process.argv[2]
const cancellation = login === '--cancel' && process.argv.length === 4
if (!login || (!cancellation && process.argv.length !== 3)) {
  console.error('Usage: pnpm --filter @envhandoff/api invite-owner <GitHub-login> | --cancel <invitation-id>')
  process.exitCode = 1
} else {
  let db: Database | undefined
  try {
    const origin = process.env.WEB_ORIGIN ?? ''
    const url = new URL(origin)
    if (url.origin !== origin || !(url.protocol === 'https:' || (process.env.NODE_ENV === 'development' && origin === 'http://localhost:5173'))) throw new Error('Invalid WEB_ORIGIN')
    const ledgerPath = process.env.DELETION_LEDGER_PATH ?? (process.env.NODE_ENV === 'development' ? '.data/deletions' : '')
    if (!ledgerPath) throw new Error('Independent deletion ledger required')
    const account = cancellation ? null : await githubAccount(login)
    db = new Database(process.env.DATABASE_URL ?? '')
    await db.migrate()
    await new Deletions(ledgerPath).sync(db)
    const organizations = new Organizations(db)
    if (cancellation) {
      await organizations.cancelOpening(process.argv[3]!)
      console.log('Opening invitation cancelled')
    } else if (account) {
      const invite = await organizations.issueOwner(account)
      console.log(`Organization-opening invitation ${invite.id} for ${account.login} (GitHub ID ${account.id}), expires ${new Date(invite.expiresAt).toISOString()}`)
      console.log(origin + '/pro#invite=' + invite.token)
    }
  } catch { console.error('Could not issue invitation. Check the GitHub login, network, WEB_ORIGIN, DATABASE_URL and DELETION_LEDGER_PATH.'); process.exitCode = 1 }
  finally { await db?.close() }
}

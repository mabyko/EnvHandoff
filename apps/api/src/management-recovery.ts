import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from './database.ts'
import { Deletions } from './deletions.ts'
import { parseRecoveryArgs, recoveryAccount, recoverManagement, registerRecoveryContact } from './recovery.ts'

const usage = `Operator-only management recovery; no messages are sent.
  management-recovery register-contact --org <UUID> --contact-ref <UUID> --case-ref <UUID> --attest-contact-verified [--apply]
  management-recovery recover --org <UUID> --contact-ref <UUID> --case-ref <UUID> --login <GitHub-login> --github-id <numeric-ID> --owners <numeric-ID,...|none> --attest-contact-verified --attest-all-owners-lost [--apply]
UUID references must point to operator records with contact verification evidence; never pass contact details or secrets.
The replacement account must sign in once first. --owners must match all current Owners, including disabled accounts.
Without --apply, roles, sessions, invitations and contacts stay unchanged; metadata-read audit events are recorded.
Migrations and mandatory deletion-ledger enforcement still run, including previously requested deletions.
DATABASE_URL and DELETION_LEDGER_PATH are required.
The replacement Owner automatically receives all file-operation permissions in this organization.
Demoted Owners revert to their stored Member permissions; affected requests and shares are revoked.
Device keys, device trust and access to another recipient's past files are never restored.`

export async function executeManagementRecovery(db:Database,ledger:Deletions,input:ReturnType<typeof parseRecoveryArgs>,fetcher=fetch) {
  await ledger.sync(db)
  const target = input.mode === 'recover' ? await recoveryAccount(input.login,input.githubId,fetcher) : undefined
  return db.transaction(async () => {
    // A deletion may have become durable while the provider identity was being checked.
    await ledger.sync(db)
    return input.mode === 'register-contact' ? registerRecoveryContact(db,input)
      : recoverManagement(db,{...input,target:target!})
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--help') console.log(usage)
  else {
    let db: Database | undefined
    try {
      const input = parseRecoveryArgs(process.argv.slice(2))
      if (!process.env.DELETION_LEDGER_PATH) throw new Error('deletion_ledger_required')
      db = new Database(process.env.DATABASE_URL ?? '')
      await db.migrate()
      const ledger = new Deletions(process.env.DELETION_LEDGER_PATH)
      const result = await executeManagementRecovery(db,ledger,input)
      console.log(JSON.stringify(result))
    } catch (error) {
      const safe = new Set(['invalid_arguments','invalid_reference','invalid_github_id','invalid_github_login','invalid_github_account',
        'contact_verification_required','owner_loss_attestation_required','github_id_mismatch','github_account_not_found','github_unavailable',
        'organization_unavailable','contact_already_registered','registered_contact_required','separate_recovery_case_required',
        'target_must_sign_in_first','recovery_case_conflict','owner_list_changed','invalid_owner_list','member_limit','deletion_ledger_required'])
      console.error(error instanceof Error && safe.has(error.message) ? error.message : 'management_recovery_failed')
      console.error('No recovery completion is confirmed. Review the operator case and current state; use --help for usage.')
      process.exitCode = 1
    } finally { await db?.close() }
  }
}

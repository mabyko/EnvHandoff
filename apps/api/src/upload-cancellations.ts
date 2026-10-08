import type { Database } from './database.ts'
import { HttpError } from './http.ts'
import { limits } from './limits.ts'

type Scope = { userId: string; orgId: string; kind: 'share' | 'team'; reservationId: string; requestId?: string }

// Reservation creation and cancellation both call these within the serialized
// DB transaction, including across API processes. Other actors cannot fence IDs.
export async function uploadCancelled(db: Database, scope: Scope): Promise<boolean> {
  const prior = await db.get<{ request_id: string }>('SELECT request_id FROM upload_cancellations WHERE user_id=$1 AND org_id=$2 AND kind=$3 AND reservation_id=$4', scope.userId, scope.orgId, scope.kind, scope.reservationId)
  if (prior && prior.request_id !== (scope.requestId ?? '')) throw new HttpError(409, 'operation_conflict')
  return !!prior
}

export async function fenceUpload(db: Database, scope: Scope, now: number, absent: boolean): Promise<void> {
  if (await uploadCancelled(db, scope)) return
  if (absent) {
    const attempts = await db.get<{ n: number }>('SELECT count(*) AS n FROM creation_attempts WHERE user_id=$1 AND created_at>$2', scope.userId, now - limits.creationWindowMs)
    if (attempts!.n >= limits.creationAttempts) throw new HttpError(429, 'request_rate_limit')
  }
  await db.run('INSERT INTO upload_cancellations(user_id,org_id,kind,reservation_id,request_id,created_at) VALUES($1,$2,$3,$4,$5,$6)', scope.userId, scope.orgId, scope.kind, scope.reservationId, scope.requestId ?? '', now)
}

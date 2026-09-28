import { randomBytes, randomUUID } from 'node:crypto'
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { deviceHash, identityFingerprint } from '@envhandoff/protocol/device-proof'
import type { DeviceAction, DeviceIdentity } from '@envhandoff/protocol/device-proof'
import { DeviceRegistry } from './devices.ts'
import type { DeviceSession } from './devices.ts'
import type { Database } from './database.ts'
import { fields, HttpError, jsonBody } from './http.ts'
import { base32, openTotp, sealTotp, totpCounter } from './totp.ts'

export type SecuritySession = { user_id: string; token_hash: string; login: string; created_at: number }
type Passkey = { id: string; public_key: Buffer; counter: number; label: string; created_at: number }
type Challenge = { id: string; challenge: string; label: string; expires_at: number }
const RECENT = 15 * 60_000
function sameOriginCeremony(response: unknown): void {
  const encoded = (response as { response?: { clientDataJSON?: unknown } } | undefined)?.response?.clientDataJSON
  if (typeof encoded !== 'string') throw new Error('Missing client data')
  const data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  if (data.crossOrigin || data.topOrigin) throw new Error('Embedded ceremonies are not supported')
}
const label = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 60 || /[\p{Cc}\p{Cf}]/u.test(value)) throw new HttpError(400, 'invalid_input')
  return value.trim()
}

export class SecurityApi {
  private readonly db: Database
  private readonly origin: string
  private readonly rpID: string
  private readonly key?: Buffer
  private readonly clock: () => number
  constructor(db: Database, origin: string, encryptionKey?: string, clock = Date.now) {
    this.db = db; this.origin = origin; this.rpID = new URL(origin).hostname; this.clock = clock
    if (encryptionKey) {
      if (!/^[0-9a-f]{64}$/.test(encryptionKey)) throw new Error('TOTP_ENCRYPTION_KEY must be 32 bytes in lowercase hex')
      this.key = Buffer.from(encryptionKey, 'hex')
    }
  }
  private async recent(auth: SecuritySession): Promise<number> {
    const row = await this.db.get('SELECT verified_at FROM reauthentications WHERE session_hash=$1', auth.token_hash)
    const at = row?.verified_at as number | undefined
    return at !== undefined && at <= this.clock() && this.clock() - at < RECENT ? at : 0
  }
  async requireRecent(auth: SecuritySession): Promise<void> {
    if (!await this.recent(auth)) throw new HttpError(403, 'reauthentication_required')
  }
  private async factorCount(auth: SecuritySession): Promise<number> {
    return (await this.db.get('SELECT (SELECT count(*) FROM passkeys WHERE user_id=$1) + (SELECT count(*) FROM totp_credentials WHERE user_id=$1) AS n', auth.user_id))!.n as number
  }
  private async enrollment(auth: SecuritySession): Promise<void> {
    if (await this.factorCount(auth)) await this.requireRecent(auth)
    // Bootstrap establishes a first factor; OAuth itself never grants recent reauthentication.
    else if (this.clock() - auth.created_at >= RECENT) throw new HttpError(403, 'fresh_login_required')
  }
  private async event(auth: SecuritySession, event: string): Promise<void> {
    await this.db.run('INSERT INTO auth_events (user_id,event,created_at) VALUES ($1,$2,$3)', auth.user_id, event, this.clock())
  }
  private async verified(auth: SecuritySession): Promise<void> {
    await this.db.run('INSERT INTO reauthentications VALUES ($1,$2) ON CONFLICT(session_hash) DO UPDATE SET verified_at=excluded.verified_at', auth.token_hash, this.clock())
    await this.event(auth, 'reauthenticated')
  }
  private async rate(auth: SecuritySession, scope: string): Promise<void> {
    const count = await this.db.transaction(async () => {
      await this.db.run('DELETE FROM security_attempts WHERE until_at <= $1', this.clock())
      return (await this.db.get('INSERT INTO security_attempts VALUES ($1,$2,1,$3) ON CONFLICT(user_id,scope) DO UPDATE SET count=security_attempts.count+1 RETURNING count', auth.user_id, scope, this.clock() + 10 * 60_000))!.count as number
    })
    // Increment commits even when verification fails, across sessions and API instances.
    if (count > (scope === 'totp' ? 5 : 60)) throw new HttpError(429, 'security_rate_limited')
  }
  private async saveChallenge(auth: SecuritySession, purpose: string, challenge: string, name = ''): Promise<string> {
    const id = randomUUID()
    await this.db.run('DELETE FROM security_challenges WHERE expires_at <= $1 OR (session_hash=$2 AND purpose=$3)', this.clock(), auth.token_hash, purpose)
    if (((await this.db.get('SELECT count(*) AS n FROM security_challenges WHERE user_id=$1', auth.user_id))!.n as number) >= 10) throw new HttpError(429, 'security_rate_limited')
    await this.db.run('INSERT INTO security_challenges VALUES ($1,$2,$3,$4,$5,$6,$7)', id, auth.token_hash, auth.user_id, purpose, challenge, name, this.clock() + 5 * 60_000)
    return id
  }
  private async challenge(auth: SecuritySession, purpose: string, id: unknown): Promise<Challenge> {
    if (typeof id !== 'string') throw new HttpError(400, 'invalid_input')
    const row = await this.db.get('SELECT id,challenge,label,expires_at FROM security_challenges WHERE id=$1 AND session_hash=$2 AND user_id=$3 AND purpose=$4 AND expires_at>$5', id, auth.token_hash, auth.user_id, purpose, this.clock())
    if (!row) throw new HttpError(409, 'challenge_expired')
    return row as Challenge
  }
  async prune(): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.run('DELETE FROM security_challenges WHERE expires_at <= $1', this.clock())
      await this.db.run('DELETE FROM security_attempts WHERE until_at <= $1', this.clock())
      await this.db.run('DELETE FROM reauthentications WHERE verified_at <= $1', this.clock() - RECENT)
    })
    await new DeviceRegistry(this.db, this.clock).prune()
  }
  async handle(request: Request, authenticate: () => Promise<SecuritySession>): Promise<unknown> {
    const auth = await authenticate(), path = new URL(request.url).pathname
    const current = async () => {
      const value = await authenticate()
      if (value.user_id !== auth.user_id || value.token_hash !== auth.token_hash) throw new HttpError(401, 'session_expired')
      await this.db.run('UPDATE sessions SET last_seen=$1 WHERE token_hash=$2', this.clock(), auth.token_hash)
      return value
    }
    const passkeys = () => this.db.all<Passkey>('SELECT id,public_key,counter,label,created_at FROM passkeys WHERE user_id=$1 ORDER BY created_at,id', auth.user_id)
    if (request.method === 'GET' && path === '/security') return this.db.transaction(async () => {
      await current()
      const devices = await this.db.all('SELECT identity,status FROM devices WHERE user_id=$1 ORDER BY id', auth.user_id)
      const at = await this.recent(auth)
      return {
        passkeys: (await passkeys()).map(({ id, label, created_at }) => ({ id, label, createdAt: created_at })),
        totp: !!await this.db.get('SELECT user_id FROM totp_credentials WHERE user_id=$1', auth.user_id),
        totpAvailable: !!this.key, reauthenticatedUntil: at ? at + RECENT : 0,
        sessionHash: await deviceHash(auth.token_hash),
        canRegisterDevice: !!await this.db.get('SELECT m.user_id FROM memberships m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=$1 AND o.active=1 LIMIT 1', auth.user_id),
        devices: await Promise.all(devices.map(async row => {
          const identity: DeviceIdentity = JSON.parse(row.identity as string)
          return { identity, status: row.status, fingerprint: await identityFingerprint(identity) }
        })),
      }
    })
    if (request.method !== 'POST') throw new HttpError(405)
    const body = await jsonBody(request)
    await this.rate(auth, 'mutation')
    if (path === '/security/passkeys/options') return this.db.transaction(async () => {
      fields(body, ['label']); await current(); await this.enrollment(auth)
      const keys = await passkeys()
      if (keys.length >= 5) throw new HttpError(409, 'passkey_limit')
      const name = label(body.label)
      const options = await generateRegistrationOptions({
        rpName: 'EnvHandoff', rpID: this.rpID, userID: new TextEncoder().encode(auth.user_id), userName: auth.login,
        attestationType: 'none', supportedAlgorithmIDs: [-7, -257],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: keys.map(({ id }) => ({ id })),
      })
      return { id: await this.saveChallenge(auth, 'register', options.challenge, name), options }
    })
    if (path === '/security/passkeys/verify') {
      fields(body, ['id', 'response'])
      const challenge = await this.challenge(auth, 'register', body.id)
      let result
      try {
        sameOriginCeremony(body.response)
        result = await verifyRegistrationResponse({ response: body.response as RegistrationResponseJSON, expectedChallenge: challenge.challenge,
          expectedOrigin: this.origin, expectedRPID: this.rpID, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] })
      } catch { throw new HttpError(400, 'invalid_passkey') }
      if (!result.verified || !result.registrationInfo) throw new HttpError(400, 'invalid_passkey')
      return this.db.transaction(async () => {
        await current(); await this.enrollment(auth); await this.challenge(auth, 'register', body.id)
        const credential = result.registrationInfo!.credential
        if ((await passkeys()).length >= 5 || await this.db.get('SELECT id FROM passkeys WHERE id=$1', credential.id)) throw new HttpError(409, 'passkey_limit')
        await this.db.run('INSERT INTO passkeys VALUES ($1,$2,$3,$4,$5,$6)', credential.id, auth.user_id, Buffer.from(credential.publicKey), credential.counter, challenge.label, this.clock())
        await this.db.run('DELETE FROM security_challenges WHERE id=$1', challenge.id)
        await this.event(auth, 'passkey_registered')
        return { ok: true }
      })
    }
    if (path === '/security/reauth/options') return this.db.transaction(async () => {
      fields(body, []); await current()
      const keys = await passkeys()
      if (!keys.length) throw new HttpError(409, 'passkey_required')
      const options = await generateAuthenticationOptions({ rpID: this.rpID, userVerification: 'required', allowCredentials: keys.map(({ id }) => ({ id })) })
      return { id: await this.saveChallenge(auth, 'authenticate', options.challenge), options }
    })
    if (path === '/security/reauth/verify') {
      fields(body, ['id', 'response'])
      const challenge = await this.challenge(auth, 'authenticate', body.id)
      const response = body.response as AuthenticationResponseJSON | undefined
      const credential = (await passkeys()).find(key => key.id === response?.id)
      if (!credential || !response || (response.response?.userHandle && response.response.userHandle !== Buffer.from(auth.user_id).toString('base64url'))) throw new HttpError(400, 'invalid_passkey')
      let result
      try {
        sameOriginCeremony(response)
        result = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: this.origin, expectedRPID: this.rpID,
          credential: { id: credential.id, publicKey: new Uint8Array(credential.public_key), counter: credential.counter }, requireUserVerification: true })
      } catch { throw new HttpError(400, 'invalid_passkey') }
      if (!result.verified) throw new HttpError(400, 'invalid_passkey')
      return this.db.transaction(async () => {
        await current(); await this.challenge(auth, 'authenticate', body.id)
        const changed = await this.db.run('UPDATE passkeys SET counter=$1 WHERE id=$2 AND user_id=$3 AND counter=$4', result.authenticationInfo.newCounter, credential.id, auth.user_id, credential.counter)
        if (changed.changes !== 1) throw new HttpError(409, 'invalid_passkey')
        await this.db.run('DELETE FROM security_challenges WHERE id=$1', challenge.id)
        await this.verified(auth)
        return { ok: true }
      })
    }
    if (path === '/security/totp/options') return this.db.transaction(async () => {
      fields(body, []); await current(); await this.enrollment(auth)
      if (!this.key) throw new HttpError(503, 'totp_unavailable')
      if (await this.db.get('SELECT user_id FROM totp_credentials WHERE user_id=$1', auth.user_id)) throw new HttpError(409, 'totp_exists')
      const secret = randomBytes(20)
      try {
        const encoded = base32(secret), id = await this.saveChallenge(auth, 'totp', sealTotp(secret, this.key, auth.user_id))
        const params = new URLSearchParams({ secret: encoded, issuer: 'EnvHandoff', algorithm: 'SHA1', digits: '6', period: '30' })
        return { id, secret: encoded, uri: `otpauth://totp/EnvHandoff:${encodeURIComponent(auth.login)}?${params}` }
      } finally { secret.fill(0) }
    })
    if (path === '/security/totp/confirm' || path === '/security/totp/verify') {
      const enrollment = path.endsWith('/confirm')
      fields(body, enrollment ? ['id', 'code'] : ['code'])
      await this.rate(auth, 'totp')
      return this.db.transaction(async () => {
        await current()
        if (!this.key) throw new HttpError(503, 'totp_unavailable')
        if (enrollment) await this.enrollment(auth)
        const saved = await this.db.get('SELECT secret,last_counter FROM totp_credentials WHERE user_id=$1', auth.user_id)
        const challenge = enrollment ? await this.challenge(auth, 'totp', body.id) : undefined
        if ((enrollment && saved) || (!enrollment && !saved)) throw new HttpError(409, 'totp_unavailable')
        const secret = openTotp(challenge?.challenge ?? saved!.secret as string, this.key, auth.user_id)
        let counter: number | undefined
        try { counter = totpCounter(secret, body.code, this.clock(), enrollment ? -1 : saved!.last_counter as number) }
        finally { secret.fill(0) }
        if (counter === undefined) throw new HttpError(400, 'invalid_totp')
        if (enrollment) {
          await this.db.run('INSERT INTO totp_credentials VALUES ($1,$2,$3,$4)', auth.user_id, challenge!.challenge, counter, this.clock())
          await this.db.run('DELETE FROM security_challenges WHERE id=$1', challenge!.id)
          await this.event(auth, 'totp_registered')
        } else {
          await this.db.run('UPDATE totp_credentials SET last_counter=$1 WHERE user_id=$2', counter, auth.user_id)
          await this.verified(auth)
        }
        return { ok: true }
      })
    }
    if (path === '/security/passkeys/remove' || path === '/security/totp/remove') return this.db.transaction(async () => {
      fields(body, path.includes('/passkeys/') ? ['id'] : []); await current(); await this.requireRecent(auth)
      if (await this.factorCount(auth) <= 1) throw new HttpError(409, 'last_factor')
      if (path.includes('/passkeys/')) {
        if (typeof body.id !== 'string') throw new HttpError(400, 'invalid_input')
        await this.db.run('DELETE FROM passkeys WHERE id=$1 AND user_id=$2', body.id, auth.user_id)
      } else await this.db.run('DELETE FROM totp_credentials WHERE user_id=$1', auth.user_id)
      await this.db.run('DELETE FROM reauthentications WHERE session_hash IN (SELECT token_hash FROM sessions WHERE user_id=$1)', auth.user_id)
      await this.db.run('DELETE FROM security_challenges WHERE user_id=$1', auth.user_id)
      await this.event(auth, 'factor_removed')
      return { ok: true }
    })
    if (path === '/security/devices/challenge' || path === '/security/devices/complete') {
      const deviceSession = async (_?: DeviceSession, action?: DeviceAction): Promise<DeviceSession> => {
        await current()
        if (action && action !== 'revoke' && !await this.db.get('SELECT m.user_id FROM memberships m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=$1 AND o.active=1 LIMIT 1', auth.user_id)) throw new HttpError(403, 'membership_required')
        return { userId: auth.user_id, sessionId: auth.token_hash, active: true, reauthenticatedAt: await this.recent(auth) }
      }
      const registry = new DeviceRegistry(this.db, this.clock, deviceSession), session = await deviceSession()
      try {
        if (path.endsWith('/complete')) {
          fields(body, ['id', 'proof'])
          if (typeof body.id !== 'string' || typeof body.proof !== 'string') throw new HttpError(400, 'invalid_input')
          return await registry.complete(session, body.id, body.proof)
        }
        if (body.action === 'register' || body.action === 'recover') {
          fields(body, ['action', 'identity'])
          if (!body.identity || typeof body.identity !== 'object') throw new HttpError(400, 'invalid_input')
          return body.action === 'register' ? await registry.beginRegistration(session, body.identity as DeviceIdentity) : await registry.beginRecovery(session, body.identity as DeviceIdentity)
        }
        fields(body, ['action', 'actorId', 'targetId'])
        if (!['approve', 'revoke'].includes(body.action as string) || typeof body.actorId !== 'string' || typeof body.targetId !== 'string') throw new HttpError(400, 'invalid_input')
        return await registry.beginAction(session, body.action as 'approve' | 'revoke', body.actorId, body.targetId)
      } catch (error) {
        if (error instanceof HttpError || (error instanceof Error && 'code' in error)) throw error
        throw new HttpError(409, error instanceof Error && error.message === 'Recent reauthentication required' ? 'reauthentication_required' : 'device_action_failed')
      }
    }
    throw new HttpError(404)
  }
}

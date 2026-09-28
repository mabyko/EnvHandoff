import { limits } from './limits.ts'
import { invalidateRequests } from './requests.ts';
import type { Database } from './database.ts';
import { deviceHash, deviceId, encryptDeviceChallenge, identityFingerprint, importDevicePublicKey, verifyDeviceProof, DEVICE_CHALLENGE_MS } from '@envhandoff/protocol/device-proof';
import type { DeviceAction, DeviceChallenge, DeviceIdentity, EncryptedDeviceChallenge } from '@envhandoff/protocol/device-proof';
// Construct only from the current server session. Never deserialize this from request input.
export type DeviceSession = {
  userId: string;
  sessionId: string;
  reauthenticatedAt: number;
  active: boolean;
};
export type RegisteredDevice = {
  identity: DeviceIdentity;
  status: 'pending' | 'active' | 'revoked';
};
type ChallengeRow = {
  body: string;
  secret_hash: string;
  consumed: number | null;
};
export class DeviceRegistry {
  readonly db: Database;
  private readonly clock: () => number;
  private readonly refreshSession?: (auth: DeviceSession, action: DeviceAction) => Promise<DeviceSession>;
  constructor(db: Database, clock = Date.now, refreshSession?: (auth: DeviceSession, action: DeviceAction) => Promise<DeviceSession>) {
    this.clock = clock;
    this.db = db;
    this.refreshSession = refreshSession;
  }
  private session(auth: DeviceSession, recent = false): void {
    deviceId(auth.userId);
    if (!auth.active || typeof auth.sessionId !== 'string' || auth.sessionId.length < 32 || auth.sessionId.length > 256)
      throw new Error('Invalid session');
    if (recent && (!Number.isSafeInteger(auth.reauthenticatedAt) || auth.reauthenticatedAt > this.clock() || this.clock() - auth.reauthenticatedAt >= 15 * 60 * 1000))
      throw new Error('Recent reauthentication required');
  }
  async get(auth: DeviceSession, id: string): Promise<RegisteredDevice | undefined> {
    this.session(auth);
    const row = (await this.db.get("SELECT identity, status FROM devices WHERE id = $1 AND user_id = $2", deviceId(id), auth.userId));
    return row ? { identity: JSON.parse(row.identity as string), status: row.status as RegisteredDevice['status'] } : undefined;
  }
  private async allowed(auth: DeviceSession, challenge: DeviceChallenge): Promise<void> {
    if (!['register', 'approve', 'revoke', 'recover'].includes(challenge.action)) throw new Error('Invalid registry action');
    if (this.refreshSession) {
      const current = await this.refreshSession(auth, challenge.action);
      if (current.userId !== auth.userId || current.sessionId !== auth.sessionId) throw new Error('Session changed');
      auth = current;
    }
    this.session(auth, challenge.action !== 'register');
    if (auth.userId !== challenge.actor.userId || auth.userId !== challenge.target.userId)
      throw new Error('Device account mismatch');
    if (challenge.action === 'register' || challenge.action === 'recover') {
      if (JSON.stringify(challenge.actor) !== JSON.stringify(challenge.target) || (await this.db.get("SELECT id FROM devices WHERE id = $1", challenge.target.deviceId)))
        throw new Error('Device already exists');
      const count = (await this.db.get("SELECT count(*) AS n FROM devices WHERE user_id = $1 AND status != 'revoked'", auth.userId))!.n as number;
      if (count >= limits.userDevices && challenge.action !== 'recover')
        throw new Error('Device limit reached');
    }
    else {
      const actor = (await this.get(auth, challenge.actor.deviceId));
      const target = (await this.get(auth, challenge.target.deviceId));
      const pendingSelfRevoke = challenge.action === 'revoke' && actor?.status === 'pending' && challenge.actor.deviceId === challenge.target.deviceId;
      if ((!pendingSelfRevoke && actor?.status !== 'active') || !actor || !target || target.status === 'revoked' ||
        JSON.stringify(actor.identity) !== JSON.stringify(challenge.actor) || JSON.stringify(target.identity) !== JSON.stringify(challenge.target))
        throw new Error('Device is unavailable');
      if (challenge.action === 'approve' && (target.status !== 'pending' || actor.identity.deviceId === target.identity.deviceId))
        throw new Error('Invalid device approval');
    }
  }
  async beginRegistration(auth: DeviceSession, identity: DeviceIdentity): Promise<EncryptedDeviceChallenge> {
    this.session(auth);
    identity = structuredClone(identity);
    // Validate canonical IDs, both public points, and reject extra/private key fields.
    await identityFingerprint(identity);
    await importDevicePublicKey(identity.encryptionKey, 'ECDH');
    await importDevicePublicKey(identity.signingKey, 'ECDSA');
    return this.begin(auth, 'register', identity, identity);
  }
  async beginRecovery(auth: DeviceSession, identity: DeviceIdentity): Promise<EncryptedDeviceChallenge> {
    this.session(auth, true);
    identity = structuredClone(identity);
    await identityFingerprint(identity);
    await importDevicePublicKey(identity.encryptionKey, 'ECDH');
    await importDevicePublicKey(identity.signingKey, 'ECDSA');
    return this.begin(auth, 'recover', identity, identity);
  }
  async beginAction(auth: DeviceSession, action: 'approve' | 'revoke', actorId: string, targetId: string): Promise<EncryptedDeviceChallenge> {
    this.session(auth, true);
    if (action !== 'approve' && action !== 'revoke')
      throw new Error('Invalid device action');
    const actor = (await this.get(auth, actorId)), target = (await this.get(auth, targetId));
    if (!actor || !target)
      throw new Error('Device is unavailable');
    return this.begin(auth, action, actor.identity, target.identity);
  }
  private async begin(auth: DeviceSession, action: DeviceAction, actor: DeviceIdentity, target: DeviceIdentity): Promise<EncryptedDeviceChallenge> {
    const challenge: DeviceChallenge = {
      id: crypto.randomUUID(), action, sessionHash: await deviceHash(auth.sessionId),
      actor: structuredClone(actor), target: structuredClone(target),
      issuedAt: this.clock(), expiresAt: this.clock() + DEVICE_CHALLENGE_MS,
    };
    challenge.expiresAt = challenge.issuedAt + DEVICE_CHALLENGE_MS;
    await this.allowed(auth, challenge);
    const { wire, secretHash } = await encryptDeviceChallenge(challenge);
    await this.db.transaction(async () => {
      await this.allowed(auth, challenge);
      await this.db.run("DELETE FROM device_challenges WHERE expires_at <= $1", this.clock());
      const count = (await this.db.get("SELECT count(*) AS n FROM device_challenges WHERE user_id = $1 AND consumed IS NULL", auth.userId))!.n as number;
      if (count >= 10 || this.clock() >= challenge.expiresAt)
        throw new Error('Challenge limit or expiry');
      await this.db.run("INSERT INTO device_challenges VALUES ($1, $2, $3, $4, $5, NULL)", challenge.id, auth.userId, JSON.stringify(challenge), secretHash, challenge.expiresAt);
    });
    return wire;
  }
  async complete(auth: DeviceSession, challengeId: string, proof: string): Promise<RegisteredDevice> {
    this.session(auth);
    const row = (await this.db.get("SELECT body, secret_hash, consumed FROM device_challenges WHERE id = $1 AND user_id = $2", deviceId(challengeId), auth.userId)) as ChallengeRow | undefined;
    if (!row || row.consumed !== null)
      throw new Error('Challenge unavailable');
    const challenge: DeviceChallenge = JSON.parse(row.body);
    if (challenge.sessionHash !== await deviceHash(auth.sessionId) || !await verifyDeviceProof(challenge, proof, row.secret_hash))
      throw new Error('Invalid device proof');
    return (await this.db.transaction(async () => {
      await this.allowed(auth, challenge);
      const now = this.clock();
      if (now < challenge.issuedAt || now >= challenge.expiresAt)
        throw new Error('Challenge expired');
      const changed = (await this.db.run("UPDATE device_challenges SET consumed = $1, secret_hash = $2 WHERE id = $3 AND consumed IS NULL", now, '', challenge.id));
      if (changed.changes !== 1)
        throw new Error('Challenge already consumed');
      if (challenge.action === 'register' || challenge.action === 'recover') {
        const previous = (await this.db.get("SELECT id FROM devices WHERE user_id = $1 LIMIT 1", auth.userId));
        if (challenge.action === 'recover') {
          await this.db.run("UPDATE devices SET status = 'revoked' WHERE user_id = $1", auth.userId);
          await this.db.run("DELETE FROM device_challenges WHERE user_id = $1", auth.userId);
        }
        await this.db.run("INSERT INTO devices VALUES ($1, $2, $3, $4)", challenge.target.deviceId, auth.userId, JSON.stringify(challenge.target), previous && challenge.action !== 'recover' ? 'pending' : 'active');
      }
      else {
        await this.db.run("UPDATE devices SET status = $1 WHERE id = $2", challenge.action === 'approve' ? 'active' : 'revoked', challenge.target.deviceId);
      }
      await this.db.run("INSERT INTO device_proofs VALUES ($1, $2, $3, $4, $5)", challenge.id, auth.userId, challenge.target.deviceId, proof, now);
      await invalidateRequests(this.db, now);
      await this.event(auth.userId, challenge.target.deviceId, challenge.action, now);
      return (await this.get(auth, challenge.target.deviceId))!;
    }));
  }
  async prune(): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.run("DELETE FROM device_challenges WHERE expires_at <= $1", this.clock());
      const cutoff = this.clock() - 30 * 24 * 60 * 60 * 1000;
      await this.db.run("DELETE FROM device_proofs WHERE created_at <= $1", cutoff);
      await this.db.run("DELETE FROM device_events WHERE created_at <= $1", cutoff);
    });
  }
  private async event(userId: string, id: string, event: string, now: number): Promise<void> {
    await this.db.run("INSERT INTO device_events (user_id, device_id, event, created_at) VALUES ($1, $2, $3, $4)", userId, id, event, now);
  }
}

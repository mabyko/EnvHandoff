import { testDatabase } from './database.ts';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { test } from 'node:test';
import { answerDeviceChallenge, deviceIdentity, DEVICE_CHALLENGE_MS } from '@envhandoff/protocol/device-proof';
import type { EncryptedDeviceChallenge } from '@envhandoff/protocol/device-proof';
import { DeviceRegistry } from '../src/devices.ts';
import type { DeviceSession } from '../src/devices.ts';
async function device(userId: string, id: string = crypto.randomUUID()) {
  const encryption = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  return { encryption, signing, identity: await deviceIdentity(userId, id, encryption.publicKey, signing.publicKey) };
}
const time = 1800000000000;
const session = (): DeviceSession => ({ userId: crypto.randomUUID(), sessionId: crypto.randomUUID(), reauthenticatedAt: time, active: true });
const answer = (wire: EncryptedDeviceChallenge, keys: Awaited<ReturnType<typeof device>>) => answerDeviceChallenge(wire, structuredClone(wire.challenge), keys.encryption, keys.signing.privateKey, time);
async function register(registry: DeviceRegistry, auth: DeviceSession, keys: Awaited<ReturnType<typeof device>>) {
  const wire = await registry.beginRegistration(auth, keys.identity);
  return registry.complete(auth, wire.challenge.id, await answer(wire, keys));
}
test('persists first registration, requires existing-device approval, consumes proofs once across restart', async (t) => {
  const testDb = await testDatabase(t);
  let registry = new DeviceRegistry(testDb.connect(), () => time);
  try {
    const auth = session(), first = await device(auth.userId), second = await device(auth.userId);
    assert.equal((await register(registry, auth, first)).status, 'active');
    assert.equal((await register(registry, auth, second)).status, 'pending');
    await assert.rejects(registry.beginAction(auth, 'approve', second.identity.deviceId, second.identity.deviceId));
    const wire = await registry.beginAction(auth, 'approve', first.identity.deviceId, second.identity.deviceId);
    const proof = await answer(wire, first);
    const [header, payload, signature] = proof.split('.');
    const publicJwk = await crypto.subtle.exportKey('jwk', first.signing.publicKey);
    assert.equal(verify('sha256', Buffer.from(header + '.' + payload), {
      key: createPublicKey({ key: { ...publicJwk }, format: 'jwk' }), dsaEncoding: 'ieee-p1363',
    }, Buffer.from(signature, 'base64url')), true);
    await registry.db.close();
    registry = new DeviceRegistry(testDb.connect(), () => time);
    const competingConnection = new DeviceRegistry(testDb.connect(), () => time);
    try {
      const results = await Promise.allSettled([registry.complete(auth, wire.challenge.id, proof), competingConnection.complete(auth, wire.challenge.id, proof)]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    }
    finally {
      await competingConnection.db.close();
    }
    assert.equal((await registry.get(auth, second.identity.deviceId))?.status, 'active');
    await registry.db.close();
    registry = new DeviceRegistry(testDb.connect(), () => time);
    await assert.rejects(registry.complete(auth, wire.challenge.id, proof));
    await assert.rejects(registry.beginRegistration(auth, (await device(auth.userId, first.identity.deviceId)).identity));
  }
  finally {
    await registry.db.close();
  }
});
test('requires both private keys, intended action/target, same account/session and unexpired proof', async (t) => {
  const testDb = await testDatabase(t);
  let now = time;
  const registry = new DeviceRegistry(testDb.connect(), () => now);
  try {
    const auth = session(), keys = await device(auth.userId), wrong = await device(auth.userId);
    const wire = await registry.beginRegistration(auth, keys.identity);
    await assert.rejects(answer(wire, wrong));
    const wrongSignature = await answerDeviceChallenge(wire, wire.challenge, keys.encryption, wrong.signing.privateKey, time);
    await assert.rejects(registry.complete(auth, wire.challenge.id, wrongSignature));
    await assert.rejects(answerDeviceChallenge(wire, { ...wire.challenge, action: 'revoke' }, keys.encryption, keys.signing.privateKey, time));
    await assert.rejects(answerDeviceChallenge(wire, { ...wire.challenge, target: wrong.identity }, keys.encryption, keys.signing.privateKey, time));
    const proof = await answer(wire, keys);
    await assert.rejects(registry.complete({ ...auth, sessionId: crypto.randomUUID() }, wire.challenge.id, proof));
    await assert.rejects(registry.complete(session(), wire.challenge.id, proof));
    await assert.rejects(registry.complete({ ...auth, active: false }, wire.challenge.id, proof));
    await assert.rejects(registry.complete(auth, wire.challenge.id, proof.replace(/^[^.]+/, 'eyJhbGciOiJub25lIn0')));
    const [header, body] = proof.split('.');
    const forgedPayload = JSON.parse(Buffer.from(body, 'base64url').toString());
    forgedPayload[2] = Buffer.alloc(32).toString('base64url');
    const forgedInput = header + '.' + Buffer.from(JSON.stringify(forgedPayload)).toString('base64url');
    const forgedSignature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.signing.privateKey, new TextEncoder().encode(forgedInput));
    await assert.rejects(registry.complete(auth, wire.challenge.id, forgedInput + '.' + Buffer.from(forgedSignature).toString('base64url')));
    assert.equal((await registry.complete(auth, wire.challenge.id, proof)).status, 'active');
    const expired = await registry.beginRegistration(auth, wrong.identity);
    const expiredProof = await answer(expired, wrong);
    now += DEVICE_CHALLENGE_MS;
    await assert.rejects(registry.complete(auth, expired.challenge.id, expiredProof), /expired/);
    assert.equal((await registry.get(auth, wrong.identity.deviceId)), undefined);
  }
  finally {
    await registry.db.close();
  }
});
test('revocation defeats pending approvals and recovery revokes all old devices without reviving IDs', async (t) => {
  const testDb = await testDatabase(t);
  const registry = new DeviceRegistry(testDb.connect(), () => time);
  try {
    const auth = session(), first = await device(auth.userId), second = await device(auth.userId), third = await device(auth.userId);
    await register(registry, auth, first);
    await register(registry, auth, second);
    const approve = await registry.beginAction(auth, 'approve', first.identity.deviceId, second.identity.deviceId);
    await registry.complete(auth, approve.challenge.id, await answer(approve, first));
    await register(registry, auth, third);
    const stale = await registry.beginAction(auth, 'approve', first.identity.deviceId, third.identity.deviceId);
    const staleProof = await answer(stale, first);
    const revoke = await registry.beginAction(auth, 'revoke', second.identity.deviceId, first.identity.deviceId);
    await registry.complete(auth, revoke.challenge.id, await answer(revoke, second));
    await assert.rejects(registry.complete(auth, stale.challenge.id, staleProof));
    await assert.rejects(registry.beginAction({ ...auth, reauthenticatedAt: time - 15 * 60 * 1000 }, 'revoke', second.identity.deviceId, third.identity.deviceId));
    const replacement = await device(auth.userId);
    const recovery = await registry.beginRecovery(auth, replacement.identity);
    assert.equal((await registry.complete(auth, recovery.challenge.id, await answer(recovery, replacement))).status, 'active');
    for (const keys of [first, second, third]) {
      assert.equal((await registry.get(auth, keys.identity.deviceId))?.status, 'revoked');
      await assert.rejects(registry.beginRegistration(auth, keys.identity));
    }
    await assert.rejects(registry.complete(auth, stale.challenge.id, staleProof));
    assert.equal((await registry.get(session(), replacement.identity.deviceId)), undefined);
  }
  finally {
    await registry.db.close();
  }
});
test('caps devices and outstanding challenges while allowing recovery at the device limit', async (t) => {
  const testDb = await testDatabase(t);
  let now = time;
  const registry = new DeviceRegistry(testDb.connect(), () => now);
  try {
    const auth = session();
    for (let i = 0; i < 5; i++)
      await register(registry, auth, await device(auth.userId));
    const replacement = await device(auth.userId);
    await assert.rejects(registry.beginRegistration(auth, replacement.identity), /limit/);
    const recovery = await registry.beginRecovery(auth, replacement.identity);
    await registry.complete(auth, recovery.challenge.id, await answer(recovery, replacement));
    for (let i = 0; i < 10; i++)
      await registry.beginRegistration(auth, (await device(auth.userId)).identity);
    await assert.rejects(registry.beginRegistration(auth, (await device(auth.userId)).identity), /limit/);
    now += 31 * 24 * 60 * 60 * 1000;
    await registry.prune();
    assert.equal((await registry.db.get("SELECT count(*) AS n FROM device_challenges"))!.n, 0);
    assert.equal((await registry.db.get("SELECT count(*) AS n FROM device_proofs"))!.n, 0);
    assert.equal((await registry.db.get("SELECT count(*) AS n FROM device_events"))!.n, 0);
    assert.equal((await registry.get(auth, replacement.identity.deviceId))?.status, 'active');
    await assert.rejects(registry.complete(auth, recovery.challenge.id, await answer(recovery, replacement)));
  }
  finally {
    await registry.db.close();
  }
});
test('a pending device can revoke itself with recent authentication and proof but cannot revoke another device', async (t) => {
  const testDb = await testDatabase(t);
  const registry = new DeviceRegistry(testDb.connect(), () => time);
  try {
    const auth = session(), first = await device(auth.userId), pending = await device(auth.userId);
    await register(registry, auth, first);
    await register(registry, auth, pending);
    await assert.rejects(registry.beginAction(auth, 'revoke', pending.identity.deviceId, first.identity.deviceId));
    await assert.rejects(registry.beginAction({ ...auth, reauthenticatedAt: time - 15 * 60_000 }, 'revoke', pending.identity.deviceId, pending.identity.deviceId));
    const wire = await registry.beginAction(auth, 'revoke', pending.identity.deviceId, pending.identity.deviceId);
    assert.equal((await registry.complete(auth, wire.challenge.id, await answer(wire, pending))).status, 'revoked');
    assert.equal((await registry.get(auth, first.identity.deviceId))?.status, 'active');
    await assert.rejects(registry.beginAction(auth, 'revoke', pending.identity.deviceId, pending.identity.deviceId));
  } finally { await registry.db.close(); }
});

// Run prepare(), reload the page, then run verify() via the local Vite server.
// Use an isolated browser profile. Only disposable test accounts and synthetic data are stored.
import { deviceFingerprint, openTeamBundle, sealTeamBundle } from '../src/lib/team-crypto.ts'
import { createLocalDevice, deleteLocalDevice, loadLocalDevice, pinPeerIdentity, trustedPeerEncryptionKey } from '../src/lib/device-keys.ts'
import { deviceIdentity, identityFingerprint, encryptDeviceChallenge, answerDeviceChallenge, verifyDeviceProof, deviceHash, DEVICE_CHALLENGE_MS } from '@envhandoff/protocol/device-proof'
import type { TeamBinding } from '../src/lib/team-crypto.ts'

const database = 'envhandoff-crypto-check'
const plaintext = 'PUBLIC_BROWSER_TEST=not-a-secret\r\n'
const binding: TeamBinding = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  environmentId: '00000000-0000-4000-8000-000000000003',
  requestId: '00000000-0000-4000-8000-000000000004',
  transferId: '00000000-0000-4000-8000-000000000005',
  senderUserId: '00000000-0000-4000-8000-000000000006',
  senderDeviceId: '00000000-0000-4000-8000-000000000007',
  recipientUserId: '00000000-0000-4000-8000-000000000008',
  recipientDeviceId: '00000000-0000-4000-8000-000000000009',
}
type StoredCheck = {
  binding: TeamBinding
  envelope: ArrayBuffer
  fingerprints: string[]
  peerFingerprint: string
  documentTime: number
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('check')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Close other crypto check tabs'))
  })
}

export async function prepare() {
  const testBinding = { ...binding, senderUserId: crypto.randomUUID(), recipientUserId: crypto.randomUUID() }
  const sender = await createLocalDevice(testBinding.senderUserId, testBinding.senderDeviceId)
  const recipient = await createLocalDevice(testBinding.recipientUserId, testBinding.recipientDeviceId)
  const peer = await deviceIdentity(recipient.userId, recipient.deviceId, recipient.keys.publicKey, recipient.signingKeys.publicKey)
  const peerFingerprint = await identityFingerprint(peer)
  // Simulates a separately confirmed fingerprint using synthetic test identities only.
  await pinPeerIdentity(sender.userId, peer, peerFingerprint)
  const envelope = await sealTeamBundle([{ file: new File([plaintext], '.env'), path: 'config/.env' }], 'browser-check', 'development', testBinding, sender.keys, recipient.keys.publicKey)
  const record: StoredCheck = {
    binding: testBinding, envelope, peerFingerprint,
    fingerprints: await Promise.all([sender, recipient].map((device) => deviceFingerprint(device.keys.publicKey))),
    documentTime: performance.timeOrigin,
  }
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('check', 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error)
      transaction.objectStore('check').put(record, 'roundtrip')
    })
  } finally { db.close() }
  return { stored: true, next: 'Reload this page, then call verify()' }
}

export async function verify() {
  const db = await openDatabase()
  let record: StoredCheck | undefined
  try {
    record = await new Promise<StoredCheck | undefined>((resolve, reject) => {
      const request = db.transaction('check').objectStore('check').get('roundtrip')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally { db.close() }
  if (!record) throw new Error('Run prepare() first')
  if (record.documentTime === performance.timeOrigin) throw new Error('Reload before verifying persisted keys')
  const { binding: testBinding } = record
  const sender = await loadLocalDevice(testBinding.senderUserId)
  const recipient = await loadLocalDevice(testBinding.recipientUserId.toUpperCase())
  if (!sender || !recipient) throw new Error('Persisted device is missing')
  const peer = await deviceIdentity(recipient.userId, recipient.deviceId, recipient.keys.publicKey, recipient.signingKeys.publicKey)
  if (await identityFingerprint(peer) !== record.peerFingerprint) throw new Error('Stored signing key changed')
  await trustedPeerEncryptionKey(sender.userId, peer)
  const untrusted = await Promise.allSettled([trustedPeerEncryptionKey(crypto.randomUUID(), peer)])
  if (untrusted[0].status !== 'rejected') throw new Error('Peer trust crossed an account boundary')
  const changedPeer = { ...peer, signingKey: (await deviceIdentity(sender.userId, sender.deviceId, sender.keys.publicKey, sender.signingKeys.publicKey)).signingKey }
  const replaced = await Promise.allSettled([
    trustedPeerEncryptionKey(sender.userId, changedPeer),
    pinPeerIdentity(sender.userId, changedPeer, await identityFingerprint(changedPeer)),
  ])
  if (replaced.some((result) => result.status !== 'rejected')) throw new Error('A pinned device key was replaced')
  if (await loadLocalDevice(crypto.randomUUID())) throw new Error('An unrelated account received a key')
  const competingAccount = crypto.randomUUID()
  const competing = await Promise.allSettled([
    createLocalDevice(competingAccount, crypto.randomUUID()),
    createLocalDevice(competingAccount, crypto.randomUUID()),
  ])
  const winner = competing.find((result) => result.status === 'fulfilled')
  if (!winner || competing.filter((result) => result.status === 'fulfilled').length !== 1) {
    throw new Error('Concurrent creation did not preserve exactly one device')
  }
  if ((await loadLocalDevice(competingAccount))?.deviceId !== winner.value.deviceId) {
    throw new Error('Concurrent creation replaced the winning device')
  }
  await deleteLocalDevice(competingAccount, winner.value.deviceId)
  const duplicate = await Promise.allSettled([createLocalDevice(testBinding.senderUserId, crypto.randomUUID())])
  if (duplicate[0].status !== 'rejected' || duplicate[0].reason.name !== 'ConstraintError') {
    throw new Error('Existing account key was overwritten')
  }
  const staleDeletion = await Promise.allSettled([deleteLocalDevice(testBinding.senderUserId, crypto.randomUUID())])
  if (staleDeletion[0].status !== 'rejected') throw new Error('A stale device ID deleted the current key')
  if (await deviceFingerprint((await loadLocalDevice(testBinding.senderUserId))!.keys.publicKey) !== record.fingerprints[0]) {
    throw new Error('Existing key changed after rejected operations')
  }
  for (const [index, key] of [sender.keys, recipient.keys, sender.signingKeys, recipient.signingKeys].entries()) {
    if (key.privateKey.extractable) throw new Error('Private key became extractable')
    let exportDenied = false
    try { await crypto.subtle.exportKey('jwk', key.privateKey) }
    catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'InvalidAccessError') throw error
      exportDenied = true
    }
    if (!exportDenied) throw new Error('Private key export succeeded')
    if (index < 2 && await deviceFingerprint(key.publicKey) !== record.fingerprints[index]) throw new Error('Fingerprint changed')
  }
  const now = Date.now()
  const { wire, secretHash } = await encryptDeviceChallenge({
    id: crypto.randomUUID(), action: 'register', actor: peer, target: peer,
    sessionHash: await deviceHash('public-test-session'), issuedAt: now, expiresAt: now + DEVICE_CHALLENGE_MS,
  })
  const proof = await answerDeviceChallenge(wire, wire.challenge, recipient.keys, recipient.signingKeys.privateKey)
  if (!await verifyDeviceProof(wire.challenge, proof, secretHash)) throw new Error('Persisted signing/decryption key proof failed')
  const decode = (bundle: Awaited<ReturnType<typeof openTeamBundle>>) => new TextDecoder().decode(bundle.files[0].bytes)
  if (decode(await openTeamBundle(record.envelope, testBinding, recipient.keys, sender.keys.publicKey)) !== plaintext) {
    throw new Error('Persisted recipient cannot open the original envelope')
  }
  const fresh = await sealTeamBundle([{ file: new File([plaintext], '.env'), path: 'config/.env' }], 'browser-check', 'development', testBinding, sender.keys, recipient.keys.publicKey)
  if (decode(await openTeamBundle(fresh, testBinding, recipient.keys, sender.keys.publicKey)) !== plaintext) {
    throw new Error('Persisted sender cannot create an authenticated envelope')
  }
  await deleteLocalDevice(testBinding.senderUserId, testBinding.senderDeviceId)
  await deleteLocalDevice(testBinding.recipientUserId, testBinding.recipientDeviceId)
  const removedTrust = await Promise.allSettled([trustedPeerEncryptionKey(sender.userId, peer)])
  if (removedTrust[0].status !== 'rejected') throw new Error('Local removal retained peer trust')
  if (await loadLocalDevice(testBinding.senderUserId) || await loadLocalDevice(testBinding.recipientUserId)) {
    throw new Error('Deleted device was restored automatically')
  }
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(database)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Test database cleanup blocked'))
  })
  return {
    passed: true, reloaded: true, privateKeyExportDenied: true, accountIsolation: true,
    overwriteDenied: true, concurrentCreationSafe: true, staleDeletionDenied: true, deletedKeysAbsent: true,
    signingProof: true, peerPins: true, testDatabaseDeleted: true, browser: navigator.userAgent,
  }
}

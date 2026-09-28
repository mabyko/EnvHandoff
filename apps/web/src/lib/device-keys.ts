import { generateDeviceKey } from './team-crypto.ts'
import { identityFingerprint, importDevicePublicKey } from '@envhandoff/protocol/device-proof'
import type { DeviceIdentity } from '@envhandoff/protocol/device-proof'

export type LocalDevice = { userId: string; deviceId: string; keys: CryptoKeyPair; signingKeys: CryptoKeyPair }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function identifier(value: string): string {
  if (typeof value !== 'string' || value.length !== 36 || !uuid.test(value)) throw new Error('Invalid device identity')
  return value.toLowerCase()
}

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('envhandoff-device-keys', 2)
    let blocked = false
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('devices')) request.result.createObjectStore('devices', { keyPath: 'userId' })
      const peers = request.result.createObjectStore('peers', { keyPath: ['ownerUserId', 'peerUserId', 'peerDeviceId'] })
      peers.createIndex('owner', 'ownerUserId')
    }
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return }
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => {
      blocked = true
      reject(new Error('Device storage is blocked; close other EnvHandoff tabs'))
    }
  })
}

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>, name = 'devices'): Promise<T> {
  const db = await openDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(['devices', 'peers'], mode)
      const request = run(transaction.objectStore(name))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onabort = () => reject(transaction.error ?? new Error('Device storage transaction aborted'))
    })
  } finally { db.close() }
}

export async function loadLocalDevice(userId: string): Promise<LocalDevice | undefined> {
  const account = identifier(userId)
  const record: LocalDevice | undefined = await transact('readonly', (store) => store.get(account))
  if (record) {
    const key = record.keys?.privateKey
    if (record.userId !== account || identifier(record.deviceId) !== record.deviceId ||
        !(key instanceof CryptoKey) || key.type !== 'private' || key.extractable ||
        key.algorithm.name !== 'ECDH' || (key.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256' ||
        !key.usages.includes('deriveBits') || !(record.keys.publicKey instanceof CryptoKey)) {
      throw new Error('Stored device key is invalid; device recovery is required')
    }
    const signing = record.signingKeys?.privateKey
    if (!(signing instanceof CryptoKey) || signing.type !== 'private' || signing.extractable ||
        signing.algorithm.name !== 'ECDSA' || (signing.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256' ||
        !signing.usages.includes('sign') || !(record.signingKeys.publicKey instanceof CryptoKey)) {
      throw new Error('Stored device has no valid signing key; register a new device ID')
    }
  }
  return record
}

// This stores a local key only; server registration and peer trust are separate steps.
export async function createLocalDevice(userId: string, deviceId: string): Promise<LocalDevice> {
  const account = identifier(userId)
  const device = identifier(deviceId)
  const record: LocalDevice = {
    userId: account, deviceId: device, keys: await generateDeviceKey(),
    signingKeys: await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']),
  }
  // add (not put) makes competing tabs fail instead of replacing an existing private key.
  await transact('readwrite', (store) => store.add(record))
  return record
}

// Local deletion does not revoke the device on the server. Callers must track both outcomes.
export async function deleteLocalDevice(userId: string, deviceId?: string): Promise<void> {
  const account = identifier(userId)
  const device = deviceId === undefined ? undefined : identifier(deviceId)
  await transact('readwrite', (store) => {
    const request = store.get(account)
    request.onsuccess = () => {
      if (device && request.result && request.result.deviceId !== device) {
        store.transaction.abort()
        return
      }
      store.delete(account)
      const peers = store.transaction.objectStore('peers')
      const cursor = peers.index('owner').openKeyCursor(IDBKeyRange.only(account))
      cursor.onsuccess = () => {
        if (cursor.result) { peers.delete(cursor.result.primaryKey); cursor.result.continue() }
      }
    }
    return request
  })
}

// confirmedFingerprint must come from the user's separate, known contact channel.
export async function pinPeerIdentity(userId: string, peer: DeviceIdentity, confirmedFingerprint: string): Promise<void> {
  const ownerUserId = identifier(userId)
  const identity = structuredClone(peer)
  const fingerprint = await identityFingerprint(identity)
  if (fingerprint !== confirmedFingerprint) throw new Error('상대 기기 지문이 일치하지 않아요. 별도 대화로 받은 지문을 다시 확인해주세요.')
  await importDevicePublicKey(identity.encryptionKey, 'ECDH')
  await importDevicePublicKey(identity.signingKey, 'ECDSA')
  await transact('readwrite', (store) => {
    const request = store.get([ownerUserId, identity.userId, identity.deviceId])
    request.onsuccess = () => {
      if (request.result && request.result.fingerprint !== fingerprint) { store.transaction.abort(); return }
      if (!request.result) store.add({ ownerUserId, peerUserId: identity.userId, peerDeviceId: identity.deviceId, fingerprint })
    }
    return request
  }, 'peers')
}

export async function trustedPeerEncryptionKey(userId: string, peer: DeviceIdentity): Promise<CryptoKey> {
  const identity = structuredClone(peer)
  const fingerprint = await identityFingerprint(identity)
  const saved = await transact('readonly', (store) => store.get([identifier(userId), identity.userId, identity.deviceId]), 'peers')
  if (!saved || saved.fingerprint !== fingerprint) throw new Error('Verify this peer device fingerprint first')
  return importDevicePublicKey(identity.encryptionKey, 'ECDH')
}

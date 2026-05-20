const DB_NAME = 'evilquest_device_crypto_v1';
const STORE_NAME = 'keys';
const DEVICE_SIGNING_KEY = 'ecdsa-p256';

interface StoredDeviceKey {
  id: string;
  keyPair: CryptoKeyPair;
}

export interface DeviceSigningIdentity {
  keyPair: CryptoKeyPair;
  publicJwk: JsonWebKey;
}

let identityPromise: Promise<DeviceSigningIdentity> | null = null;
let registeredToken = '';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('failed to open device key store'));
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('failed to read device key'));
    tx.oncomplete = () => db.close();
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error('device key read aborted'));
    };
  });
}

async function idbPut(value: StoredDeviceKey): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error('failed to store device key'));
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error('device key store aborted'));
    };
  });
}

async function generateDeviceKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>;
}

async function identityFromKeyPair(keyPair: CryptoKeyPair): Promise<DeviceSigningIdentity> {
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  return { keyPair, publicJwk };
}

export async function getDeviceSigningIdentity(): Promise<DeviceSigningIdentity> {
  if (identityPromise) return identityPromise;
  identityPromise = (async () => {
    const stored = await idbGet<StoredDeviceKey>(DEVICE_SIGNING_KEY);
    if (stored?.keyPair?.privateKey && stored.keyPair.publicKey) {
      return identityFromKeyPair(stored.keyPair);
    }
    const keyPair = await generateDeviceKeyPair();
    await idbPut({ id: DEVICE_SIGNING_KEY, keyPair });
    return identityFromKeyPair(keyPair);
  })().catch((err) => {
    identityPromise = null;
    throw err;
  });
  return identityPromise;
}

export async function ensureDeviceKeyRegistered(token: string): Promise<DeviceSigningIdentity> {
  const identity = await getDeviceSigningIdentity();
  if (registeredToken === token) return identity;
  const res = await fetch('/api/device-key', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    credentials: 'same-origin',
    body: JSON.stringify({ publicKey: identity.publicJwk }),
  });
  if (!res.ok) throw new Error(`device key registration failed (${res.status})`);
  const data = await res.json().catch(() => ({ ok: false })) as { ok?: boolean; error?: string };
  if (!data.ok) throw new Error(data.error || 'device key registration failed');
  registeredToken = token;
  return identity;
}

const DB_NAME = 'evilquest-thumb-cache'
const STORE = 'thumbs'

interface CacheEntry {
  dataUrl: string
  v: number
}

let _dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise
  _dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB not available'))
      return
    }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }).catch((err) => {
    _dbPromise = null
    throw err
  })
  return _dbPromise
}

export async function getCachedThumb(path: string, version: number): Promise<string | null> {
  try {
    const db = await openDb()
    return await new Promise<string | null>((resolve) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(path)
      req.onsuccess = () => {
        const val = req.result as CacheEntry | undefined
        resolve(val && val.v === version ? val.dataUrl : null)
      }
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

export async function putCachedThumb(path: string, dataUrl: string, version: number): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ dataUrl, v: version } satisfies CacheEntry, path)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } catch {
    // ignore
  }
}

/** Evict a single thumbnail from cache. Used after a rotation override saves
 *  so the next render produces the new pose. */
export async function clearCachedThumb(path: string): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(path)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } catch {
    // ignore
  }
}

export async function clearThumbCache(): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } catch {
    // ignore
  }
}

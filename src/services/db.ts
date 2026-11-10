// Minimal promise wrapper over IndexedDB. All persistence in the app goes
// through this module (via the store interfaces), so a future backend can
// replace storage without touching components.

const DB_NAME = 'cutlab';
const DB_VERSION = 4;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media');
      if (!db.objectStoreNames.contains('fonts')) db.createObjectStore('fonts');
      if (!db.objectStoreNames.contains('luts')) db.createObjectStore('luts');
      if (!db.objectStoreNames.contains('library')) db.createObjectStore('library');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

export const idb = {
  get: <T,>(store: string, key: string) => tx<T>(store, 'readonly', (s) => s.get(key) as IDBRequest<T>),
  set: (store: string, key: string, value: unknown) =>
    tx(store, 'readwrite', (s) => s.put(value as never, key)),
  del: (store: string, key: string) => tx(store, 'readwrite', (s) => s.delete(key)),
  keys: (store: string) => tx<string[]>(store, 'readonly', (s) => s.getAllKeys() as IDBRequest<string[]>),
};

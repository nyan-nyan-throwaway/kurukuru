// Kurukuru CD (web): everything lives in IndexedDB on the phone.
//   tracks  : song details (no audio)        key: id
//   audio   : the song files themselves      key: track id
//   images  : covers, backs, discs, booklets key: id
//   albums  : album details + which images   key: album key
//   extras  : level meters, settings blobs   key: string
const DB_NAME = 'kurukuru-cd';
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['tracks', 'audio', 'images', 'albums', 'extras']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Storage error'));
    tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
  });
}

// Safari on iPhone can fail to store Blob/File objects ("Error preparing Blob/File data"),
// so files are stored as plain bytes and turned back into Blobs when read.
async function pack(value) {
  if (value instanceof Blob) return { __bytes: await value.arrayBuffer(), type: value.type };
  return value;
}
function unpack(value) {
  if (value && value.__bytes instanceof ArrayBuffer) return new Blob([value.__bytes], { type: value.type || '' });
  return value;
}

export async function put(store, key, value) {
  const packed = await pack(value);   // read the bytes before the transaction opens
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(packed, key);
  return done(tx);
}

export async function putMany(store, entries) {
  if (!entries.length) return;
  const packed = [];
  for (const [k, v] of entries) packed.push([k, await pack(v)]);
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const [k, v] of packed) os.put(v, k);
  return done(tx);
}

export async function delMany(store, keys) {
  if (!keys.length) return;
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const k of keys) os.delete(k);
  return done(tx);
}

export async function get(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(unpack(req.result));
    req.onerror = () => reject(req.error);
  });
}

export async function del(store, key) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}

export async function all(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction(store).objectStore(store).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { out.push([cursor.key, cursor.value]); cursor.continue(); } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function storageInfo() {
  const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : {};
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
  return { usage: est.usage || 0, quota: est.quota || 0, persisted };
}

export async function askPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (e) { /* not supported */ }
  return false;
}

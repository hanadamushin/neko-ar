// IndexedDB に猫のプロフィール（見た目）と鳴き声クリップを保存する
const DB_NAME = 'neko-ar';
const VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('clips')) db.createObjectStore('clips', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const store = {
  async get(key) {
    try { return await tx('kv', 'readonly', (s) => req2p(s.get(key))); } catch { return undefined; }
  },
  async set(key, value) {
    try { await tx('kv', 'readwrite', (s) => { s.put(value, key); }); } catch (e) { console.warn('store.set', e); }
  },
  async clips() {
    try { return (await tx('clips', 'readonly', (s) => req2p(s.getAll()))) ?? []; } catch { return []; }
  },
  async putClips(list) {
    await tx('clips', 'readwrite', (s) => { for (const c of list) s.put(c); });
  },
  async updateClip(id, patch) {
    await tx('clips', 'readwrite', async (s) => {
      const c = await req2p(s.get(id));
      if (c) s.put({ ...c, ...patch });
    });
  },
  async deleteClip(id) {
    await tx('clips', 'readwrite', (s) => { s.delete(id); });
  },
  async clearAll() {
    await tx('kv', 'readwrite', (s) => { s.clear(); });
    await tx('clips', 'readwrite', (s) => { s.clear(); });
  },
};

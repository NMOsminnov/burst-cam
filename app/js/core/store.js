// Хранилище фото в IndexedDB. Работает и в окне, и в воркере (кодировщики пишут сами,
// чтобы мегабайты JPEG не гонять через главный поток).
//
//   meta  — описание фото + миниатюра (галерея читает только это)
//   blobs — полноразмерный JPEG (читается, только когда фото открыли)

const DB_NAME = 'burstcam';
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) {
        const meta = db.createObjectStore('meta', { keyPath: 'id' });
        meta.createIndex('series', 'seriesId');
      }
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => console.warn('IndexedDB: открытие заблокировано другой вкладкой');
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export async function putPhoto(meta, blob) {
  const db = await openDB();
  const tx = db.transaction(['meta', 'blobs'], 'readwrite');
  tx.objectStore('blobs').put({ id: meta.id, blob });
  tx.objectStore('meta').put(meta);
  await done(tx);
}

/** Все фото, новые сверху. */
export async function listPhotos() {
  const db = await openDB();
  const tx = db.transaction('meta');
  const all = await wrap(tx.objectStore('meta').getAll());
  all.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return all;
}

export async function getMeta(id) {
  const db = await openDB();
  return wrap(db.transaction('meta').objectStore('meta').get(id));
}

export async function getBlob(id) {
  const db = await openDB();
  const rec = await wrap(db.transaction('blobs').objectStore('blobs').get(id));
  return rec ? rec.blob : null;
}

export async function deletePhotos(ids) {
  const db = await openDB();
  const tx = db.transaction(['meta', 'blobs'], 'readwrite');
  const m = tx.objectStore('meta');
  const b = tx.objectStore('blobs');
  for (const id of ids) { m.delete(id); b.delete(id); }
  await done(tx);
}

/** Сгруппировать фото по сериям. Возвращает плитки галереи: {seriesId, cover, items[]}. */
export function groupSeries(photos) {
  const map = new Map();
  for (const p of photos) {
    let g = map.get(p.seriesId);
    if (!g) { g = { seriesId: p.seriesId, items: [] }; map.set(p.seriesId, g); }
    g.items.push(p);
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.items.sort((a, b) => a.idx - b.idx);
    g.cover = g.items[0];
    g.createdAt = g.cover.createdAt;
  }
  groups.sort((a, b) => (a.seriesId < b.seriesId ? 1 : -1));
  return groups;
}

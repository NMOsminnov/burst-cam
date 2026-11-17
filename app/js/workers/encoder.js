// Воркер-кодировщик: кадр → JPEG + миниатюра → IndexedDB.
// Задания приходят через MessagePort от планировщика (из воркера захвата или из окна),
// отчёты для интерфейса — через postMessage окну.
import { encodeJob, canvasKit } from '../core/encode.js';
import { putPhoto } from '../core/store.js';

const kit = canvasKit();
let port = null;
let index = 0;
let chain = Promise.resolve();

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    index = m.index;
    port = m.port;
    port.onmessage = (ev) => enqueue(ev.data);
    self.postMessage({ type: 'ready', index, caps: await probe() });
  } else if (m.type === 'port') {
    // Планировщик переехал (сменили камеру / источник кадров).
    port?.close?.();
    port = m.port;
    port.onmessage = (ev) => enqueue(ev.data);
  }
};

function enqueue(msg) {
  if (msg.type !== 'job') return;
  chain = chain.then(() => run(msg.job)).catch(() => {});
}

async function run(job) {
  let freed = false;
  const free = () => {
    if (!freed) { freed = true; port.postMessage({ type: 'done', index, bytes: job.bytes || 0 }); }
  };
  try {
    const { meta, blob } = await encodeJob(job, kit);
    free();
    await putPhoto(meta, blob);
    self.postMessage({ type: 'saved', meta });
  } catch (err) {
    free();
    job.bitmap?.close?.();
    job.ref?.close?.();
    self.postMessage({ type: 'error', id: job.id, message: String(err && err.message || err) });
  }
}

/** Что умеет этот браузер в воркере — для диагностики и выбора запасного пути. */
async function probe() {
  const caps = { offscreen: typeof OffscreenCanvas !== 'undefined', convertToBlob: false, jpeg: false, idb: typeof indexedDB !== 'undefined' };
  try {
    const c = new OffscreenCanvas(8, 8);
    c.getContext('2d').fillRect(0, 0, 8, 8);
    caps.convertToBlob = typeof c.convertToBlob === 'function';
    const b = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    caps.jpeg = b.type === 'image/jpeg';
  } catch { /* нет */ }
  return caps;
}

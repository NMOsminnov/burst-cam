// Пул кодировщиков. Воркеры живут всё время работы приложения; при смене камеры
// им просто выдаются новые MessagePort от нового планировщика.
import { encodeJob, canvasKit } from './encode.js';
import { putPhoto } from './store.js';

export class EncoderPool {
  constructor({ count, onSaved, onError }) {
    this.count = count;
    this.onSaved = onSaved;
    this.onError = onError;
    this.workers = [];
    this.caps = null;
    this.mode = 'worker';
    this.inline = null;
  }

  async init() {
    const url = new URL('../workers/encoder.js', import.meta.url);
    try {
      const first = await this._spawn(url, 0);
      this.caps = first.caps;
      if (!first.caps.jpeg) throw new Error('в воркере нет JPEG через OffscreenCanvas');
      this.workers.push(first.worker);
      const rest = await Promise.all(Array.from({ length: this.count - 1 }, (_, i) => this._spawn(url, i + 1)));
      rest.forEach((r) => this.workers.push(r.worker));
    } catch (e) {
      console.warn('Кодировщики в воркерах недоступны, кодирую в главном потоке:', e.message);
      this.workers.forEach((w) => w.terminate());
      this.workers = [];
      this.mode = 'main';
      this.count = 1;
      this.inline = new InlineEncoder(this);
    }
    return this;
  }

  _spawn(url, index) {
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = new Worker(url, { type: 'module' }); } catch (e) { reject(e); return; }
      const ch = new MessageChannel();
      const timer = setTimeout(() => reject(new Error('кодировщик не ответил')), 8000);
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') { clearTimeout(timer); worker._port = ch.port1; resolve({ worker, caps: m.caps }); }
        else if (m.type === 'saved') this.onSaved(m.meta);
        else if (m.type === 'error') this.onError(m);
      };
      worker.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message || 'ошибка воркера')); };
      worker.postMessage({ type: 'init', index, port: ch.port2 }, [ch.port2]);
    });
  }

  /**
   * Выдать новый комплект портов для планировщика. Возвращает порты стороны планировщика.
   * Старые порты закрываются — задания, уже стоящие в очереди, воркер доделает.
   */
  freshPorts() {
    if (this.mode === 'main') return [this.inline.freshPort()];
    return this.workers.map((w) => {
      const ch = new MessageChannel();
      w.postMessage({ type: 'port', port: ch.port2 }, [ch.port2]);
      return ch.port1;
    });
  }
}

/** Запасной кодировщик в главном потоке (iOS < 16.4: нет OffscreenCanvas.convertToBlob). */
class InlineEncoder {
  constructor(pool) {
    this.pool = pool;
    this.kit = canvasKit();
    this.chain = Promise.resolve();
  }

  freshPort() {
    const ch = new MessageChannel();
    ch.port2.onmessage = (e) => {
      if (e.data.type !== 'job') return;
      const job = e.data.job;
      this.chain = this.chain.then(async () => {
        const port = ch.port2;
        try {
          const { meta, blob } = await encodeJob(job, this.kit);
          port.postMessage({ type: 'done', index: 0, bytes: job.bytes || 0 });
          await putPhoto(meta, blob);
          this.pool.onSaved(meta);
        } catch (err) {
          port.postMessage({ type: 'done', index: 0, bytes: job.bytes || 0 });
          this.pool.onError({ id: job.id, message: String(err && err.message || err) });
        }
      });
    };
    return ch.port1;
  }
}

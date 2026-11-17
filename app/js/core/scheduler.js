// Планировщик снимков: решает, какой кадр потока взять, и раздаёт кадры кодировщикам.
//
// Работает там же, где рождаются кадры: в воркере захвата (MediaStreamTrackProcessor)
// или в главном потоке (requestVideoFrameCallback). Сам кадры не трогает — только решает.
//
// Жизнь одного нажатия:
//   arm      — палец коснулся кнопки: берём ближайший кадр и держим его (нулевая задержка затвора).
//   burst    — палец держат дольше HOLD_MS: кадр из arm становится №0 серии, дальше кадры по темпу.
//   single   — палец отпустили раньше: кадр из arm уходит в кодировщик как одиночное фото
//              (или ждёт полноразмерный снимок takePhoto и служит ему образцом ориентации).
//   stop     — палец отпустили во время серии.
import { MAX_BURST } from './config.js';
import { burstIntervalMs, dueForFrame, frameBytes } from './rate.js';

export function photoId(seriesId, idx) {
  return `${seriesId}-${String(idx).padStart(4, '0')}`;
}

/** Идентификатор серии, сортируемый по времени как строка. */
export function newSeriesId(now = Date.now()) {
  return now.toString(36).padStart(10, '0') + Math.random().toString(36).slice(2, 6);
}

export class Scheduler {
  /**
   * @param {object} o
   * @param {{post(msg: any, transfer?: Transferable[]): void}[]} o.encoders
   * @param {number} o.budgetBytes  предел памяти под кадры, ждущие сжатия
   * @param {(type: string, data: any) => void} [o.emit]  события для интерфейса
   * @param {() => number} [o.now]
   * @param {() => number} [o.wallClock]
   */
  constructor({ encoders, budgetBytes, emit = () => {}, now = () => performance.now(), wallClock = () => Date.now(), maxBurst = MAX_BURST }) {
    this.encoders = encoders.map((e) => ({ e, jobs: 0, bytes: 0 }));
    this.budget = budgetBytes;
    this.emit = emit;
    this.now = now;
    this.wall = wallClock;
    this.maxBurst = maxBurst;
    this.active = null; // текущее нажатие
    this.waiting = new Map(); // shotId → одиночный снимок, ждущий takePhoto
    this.inflightBytes = 0;
    this.lastFrame = { w: 0, h: 0 };
    this.streamFps = 30;
    this.dropped = 0;
  }

  setStream({ fps, quality } = {}) {
    if (fps) this.streamFps = fps;
    if (quality) this.quality = quality;
  }

  arm({ shotId, seriesId }) {
    if (this.active) this.stop(this.active.shotId);
    this.active = { shotId, seriesId, phase: 'armed', first: null, idx: 0, lastT: null, wantSingle: false, waitStill: false };
  }

  burst(shotId) {
    const a = this.active;
    if (!a || a.shotId !== shotId || a.phase !== 'armed') return;
    a.phase = 'burst';
    this.emit('burst-start', { shotId, seriesId: a.seriesId });
    if (a.first) {
      const { bmp, t, w, h } = a.first;
      a.first = null;
      this._dispatch(a, bmp, w, h);
      a.lastT = t;
    }
  }

  /** Одиночный снимок. waitStill — главный поток добывает полноразмерное фото, кадр ждёт его. */
  single(shotId, { waitStill = false } = {}) {
    const a = this.active;
    if (!a || a.shotId !== shotId) return;
    if (a.phase === 'burst') return this.stop(shotId);
    a.wantSingle = true;
    a.waitStill = waitStill;
    if (a.first) this._finishSingle(a);
  }

  /** Пришёл (или не пришёл — null) полноразмерный снимок для одиночного нажатия. */
  still(shotId, blob) {
    const w = this.waiting.get(shotId);
    if (!w) return;
    this.waiting.delete(shotId);
    const { a, first } = w;
    const id = photoId(a.seriesId, 0);
    if (blob) {
      this._post(
        { type: 'job', job: { id, seriesId: a.seriesId, idx: 0, createdAt: first.wall, ref: first.bmp, still: blob, width: first.w, height: first.h } },
        [first.bmp],
        frameBytes(first.w, first.h),
      );
    } else {
      this._dispatchFrame(a.seriesId, 0, first);
    }
    this.emit('shot-end', { shotId, seriesId: a.seriesId, count: 1 });
  }

  stop(shotId) {
    const a = this.active;
    if (!a || a.shotId !== shotId) return;
    if (a.phase === 'armed') {
      // Серия не началась — нажатие всё равно было: делаем одиночный снимок.
      a.wantSingle = true;
      if (a.first) this._finishSingle(a);
      return;
    }
    this.active = null;
    this.emit('shot-end', { shotId, seriesId: a.seriesId, count: a.idx });
  }

  /** Нужен ли следующий кадр потока, пришедший в момент t. */
  wants(t) {
    const a = this.active;
    if (!a) return false;
    if (a.phase === 'armed') return !a.first;
    if (a.idx >= this.maxBurst) return false;
    const interval = burstIntervalMs(this.lastFrame.w || 1920, this.lastFrame.h || 1080, this.streamFps);
    if (!dueForFrame(t, a.lastT, interval, 1000 / this.streamFps)) return false;
    const need = frameBytes(this.lastFrame.w || 1920, this.lastFrame.h || 1080);
    if (this.inflightBytes > 0 && this.inflightBytes + need > this.budget) {
      // Кодировщики не успевают: пропускаем кадр, серия идёт с той скоростью, что тянет телефон.
      this.dropped++;
      return false;
    }
    return true;
  }

  /** Кадр получен. bmp — ImageBitmap/VideoFrame (передаётся во владение). */
  accept(bmp, t, w, h) {
    this.lastFrame = { w, h };
    const a = this.active;
    if (!a) { bmp.close?.(); return; }
    if (a.phase === 'armed') {
      if (a.first) { bmp.close?.(); return; }
      a.first = { bmp, t, w, h, wall: this.wall() };
      this.emit('captured', { shotId: a.shotId, seriesId: a.seriesId, idx: 0 });
      if (a.wantSingle) this._finishSingle(a);
      return;
    }
    if (a.idx >= this.maxBurst) {
      bmp.close?.();
      return;
    }
    a.lastT = t;
    this._dispatch(a, bmp, w, h);
    if (a.idx >= this.maxBurst) this.emit('limit', { shotId: a.shotId, count: a.idx });
  }

  /** Кодировщик i закончил задание, освободив bytes. */
  done(i, bytes) {
    const enc = this.encoders[i];
    if (!enc) return;
    enc.jobs = Math.max(0, enc.jobs - 1);
    enc.bytes = Math.max(0, enc.bytes - bytes);
    this.inflightBytes = Math.max(0, this.inflightBytes - bytes);
  }

  get busy() {
    return this.encoders.reduce((s, e) => s + e.jobs, 0) + this.waiting.size;
  }

  _finishSingle(a) {
    this.active = null;
    const first = a.first;
    a.first = null;
    if (a.waitStill) {
      this.waiting.set(a.shotId, { a, first });
      return;
    }
    this._dispatchFrame(a.seriesId, 0, first);
    this.emit('shot-end', { shotId: a.shotId, seriesId: a.seriesId, count: 1 });
  }

  _dispatch(a, bmp, w, h) {
    const idx = a.idx++;
    this._dispatchFrame(a.seriesId, idx, { bmp, w, h, wall: this.wall() });
    if (idx > 0) this.emit('captured', { shotId: a.shotId, seriesId: a.seriesId, idx });
  }

  _dispatchFrame(seriesId, idx, { bmp, w, h, wall }) {
    const id = photoId(seriesId, idx);
    this._post(
      { type: 'job', job: { id, seriesId, idx, createdAt: wall, bitmap: bmp, width: w, height: h } },
      [bmp],
      frameBytes(w, h),
    );
  }

  _post(msg, transfer, bytes) {
    // Самый свободный кодировщик.
    let best = 0;
    for (let i = 1; i < this.encoders.length; i++) {
      if (this.encoders[i].bytes < this.encoders[best].bytes) best = i;
    }
    const enc = this.encoders[best];
    enc.jobs++;
    enc.bytes += bytes;
    this.inflightBytes += bytes;
    msg.job.bytes = bytes;
    if (this.quality) msg.job.quality = this.quality;
    enc.e.post(msg, transfer.filter(isTransferable));
    this.emit('queued', { id: msg.job.id, encoder: best, inflight: this.busy });
  }
}

function isTransferable(x) {
  return (typeof ImageBitmap !== 'undefined' && x instanceof ImageBitmap) || (typeof VideoFrame !== 'undefined' && x instanceof VideoFrame);
}

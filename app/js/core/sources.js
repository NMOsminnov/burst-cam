// Источники кадров. Оба реализуют одно и то же: arm/burst/single/still/stop/close + события.
//
//   WorkerSource — сырые кадры камеры в воркере (MediaStreamTrackProcessor). Лучший путь:
//                  без <video>, без лишней копии, главный поток свободен.
//   MainSource   — кадры из <video> по requestVideoFrameCallback. Работает везде
//                  (iOS до 18, Firefox), стоит одной копии кадра.
import { Scheduler } from './scheduler.js';

class Emitter {
  constructor() { this.handlers = new Set(); }
  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  fire(evt, data) { for (const h of this.handlers) h(evt, data); }
}

export class WorkerSource extends Emitter {
  /**
   * @param {'readable'|'track'} how  что передать воркеру
   */
  static async create({ track, how, ports, budget, fps }) {
    const src = new WorkerSource();
    src.kind = how === 'readable' ? 'worker:readable' : 'worker:track';
    const worker = new Worker(new URL('../workers/capture.js', import.meta.url), { type: 'module' });
    src.worker = worker;
    src.clone = track.clone(); // своя копия дорожки: закрываем независимо от превью

    const started = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('воркер захвата не стартовал')), 5000);
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'started') { clearTimeout(timer); resolve(); }
        else if (m.type === 'fatal') { clearTimeout(timer); reject(new Error(m.message)); }
        else if (m.type === 'evt') src.fire(m.evt, m.data);
        else if (m.type === 'frame-info') { src.frameInfo = m; src.fire('frame-info', m); }
        else if (m.type === 'ended') src.fire('ended', {});
      };
      worker.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message || 'ошибка воркера захвата')); };
    });

    try {
      if (how === 'readable') {
        // Chromium: процессор живёт в окне, поток кадров передаём воркеру (transferable stream).
        // eslint-disable-next-line no-undef
        const proc = new MediaStreamTrackProcessor({ track: src.clone, maxBufferSize: 2 });
        worker.postMessage({ type: 'init', readable: proc.readable, ports, budget, fps }, [proc.readable, ...ports]);
      } else {
        // Safari 18+: передаём саму дорожку, процессор создаётся в воркере.
        worker.postMessage({ type: 'init', track: src.clone, ports, budget, fps }, [src.clone, ...ports]);
      }
      await started;
    } catch (e) {
      src.close();
      throw e;
    }
    return src;
  }

  send(m) { this.worker.postMessage(m); }
  arm(shotId, seriesId) { this.send({ type: 'arm', shotId, seriesId }); }
  burst(shotId) { this.send({ type: 'burst', shotId }); }
  single(shotId, waitStill) { this.send({ type: 'single', shotId, waitStill }); }
  still(shotId, blob) { this.send({ type: 'still', shotId, blob }); }
  stop(shotId) { this.send({ type: 'stop', shotId }); }
  setStream(fps) { this.send({ type: 'stream', fps }); }
  close() {
    try { this.worker?.postMessage({ type: 'close' }); } catch { /* уже закрыт */ }
    const w = this.worker;
    setTimeout(() => w?.terminate(), 1500); // дать воркеру отпустить reader
    try { this.clone?.stop(); } catch { /* передана в воркер */ }
    this.worker = null;
  }
}

export class MainSource extends Emitter {
  static create({ video, ports, budget, fps }) {
    const src = new MainSource();
    src.kind = 'main:' + ('requestVideoFrameCallback' in HTMLVideoElement.prototype ? 'rvfc' : 'raf');
    src.video = video;
    src.sched = new Scheduler({
      encoders: ports.map((p) => ({ post: (m, tr) => p.postMessage(m, tr) })),
      budgetBytes: budget,
      emit: (evt, data) => src.fire(evt, data),
    });
    src.sched.setStream({ fps });
    ports.forEach((p, i) => { p.onmessage = (e) => { if (e.data.type === 'done') src.sched.done(i, e.data.bytes); }; });
    src.running = true;
    src.grabbing = false;
    src._tick();
    return src;
  }

  _tick() {
    if (!this.running) return;
    const v = this.video;
    const cb = (now) => {
      if (!this.running) return;
      if (!this.grabbing && v.videoWidth && this.sched.wants(now)) {
        this.grabbing = true;
        // createImageBitmap(video) снимает ровно показанный кадр, уже в правильной ориентации.
        createImageBitmap(v)
          .then((bmp) => this.sched.accept(bmp, now, bmp.width, bmp.height))
          .catch((e) => this.fire('frame-error', { message: e.message }))
          .finally(() => { this.grabbing = false; });
      }
      this._tick();
    };
    if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(cb);
    else requestAnimationFrame(cb);
  }

  arm(shotId, seriesId) { this.sched.arm({ shotId, seriesId }); }
  burst(shotId) { this.sched.burst(shotId); }
  single(shotId, waitStill) { this.sched.single(shotId, { waitStill }); }
  still(shotId, blob) { this.sched.still(shotId, blob); }
  stop(shotId) { this.sched.stop(shotId); }
  setStream(fps) { this.sched.setStream({ fps }); }
  close() { this.running = false; }
}

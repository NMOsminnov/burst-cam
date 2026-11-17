// Камера: поток, превью, источник кадров, затвор, зум, фонарик, фокус.
import { openStream, measureFps, stepDown } from '../platform/stream.js';
import { WorkerSource, MainSource } from './sources.js';
import { newSeriesId } from './scheduler.js';
import { MIN_STREAM_FPS } from './config.js';

export class Camera {
  constructor({ video, platform, pool, onEvent = () => {}, status = () => {} }) {
    this.video = video;
    this.platform = platform;
    this.pool = pool;
    this.onEvent = onEvent;
    this.status = status;
    this.facing = 'environment';
    this.stream = null;
    this.track = null;
    this.source = null;
    this.still = null;
    this.caps = {};
    this.fps = 30;
    this.starting = null;
    this.activeShot = null;
    this.generation = 0;
  }

  get settings() { return this.track ? this.track.getSettings() : {}; }

  info() {
    const s = this.settings;
    return {
      platform: this.platform.label,
      source: this.source?.kind || '—',
      width: s.width, height: s.height,
      fps: Math.round(this.fps),
      still: this.still ? { width: this.still.width, height: this.still.height } : null,
      encoders: this.pool.mode === 'main' ? 'главный поток' : `${this.pool.workers.length} воркера`,
      budgetMB: Math.round(this.platform.budget() / 1048576),
      zoom: this.caps.zoom ? { min: this.caps.zoom.min, max: this.caps.zoom.max } : null,
      torch: !!this.caps.torch,
      facing: s.facingMode || this.facing,
    };
  }

  start(facing = this.facing) {
    if (this.starting) return this.starting;
    this.starting = this._start(facing).finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start(facing) {
    const gen = ++this.generation;
    this._teardown();
    this.facing = facing;
    this.status('Включаю камеру…');
    const { stream, track, caps, fromCache } = await openStream({ facing, status: this.status });
    if (gen !== this.generation) { stream.getTracks().forEach((t) => t.stop()); return; }
    this.stream = stream;
    this.track = track;
    this.caps = caps || {};
    track.addEventListener('ended', () => {
      if (gen === this.generation) this.onEvent('camera-ended', {});
    });

    const v = this.video;
    v.srcObject = stream;
    v.muted = true;
    v.playsInline = true;
    await v.play().catch(() => {});
    await waitDims(v);
    this.fps = this.settings.frameRate || 30;

    await this._attachSource(gen);
    this.status('');
    this.onEvent('ready', this.info());

    // Фоном: проверить реальную частоту и подготовить takePhoto.
    this._tune(gen, fromCache).catch(() => {});
  }

  async _tune(gen, fromCache) {
    let fps = await measureFps(this.video);
    for (let i = 0; fps != null && fps < MIN_STREAM_FPS * 0.8 && i < 2 && !fromCache; i++) {
      if (gen !== this.generation) return;
      if (!(await stepDown(this.track, this.caps, this.facing))) break;
      await waitDims(this.video);
      fps = await measureFps(this.video);
    }
    if (gen !== this.generation) return;
    if (fps) { this.fps = Math.min(60, fps); this.source?.setStream(this.fps); }
    this.still = await this.platform.setupStill(this.track);
    if (gen !== this.generation) return;
    this.onEvent('ready', this.info());
  }

  async _attachSource(gen) {
    const budget = this.platform.budget();
    for (const plan of this.platform.sourcePlan()) {
      if (gen !== this.generation) return;
      const ports = this.pool.freshPorts();
      try {
        let src;
        if (plan === 'worker:readable') {
          if (typeof window.MediaStreamTrackProcessor !== 'function') continue;
          src = await WorkerSource.create({ track: this.track, how: 'readable', ports, budget, fps: this.fps });
        } else if (plan === 'worker:track') {
          src = await WorkerSource.create({ track: this.track, how: 'track', ports, budget, fps: this.fps });
        } else {
          src = MainSource.create({ video: this.video, ports, budget, fps: this.fps });
        }
        if (src instanceof WorkerSource && !(await orientationMatches(src, this.video))) {
          // Кадры процессора повёрнуты не так, как превью: надёжнее брать их из <video>.
          src.close();
          continue;
        }
        src.on((evt, data) => this._onSourceEvent(evt, data));
        this.source = src;
        return;
      } catch (e) {
        console.warn(`Источник ${plan} недоступен:`, e.message);
      }
    }
    throw new Error('Не удалось получить кадры камеры');
  }

  _onSourceEvent(evt, data) {
    if (evt === 'shot-end' && this.activeShot && this.activeShot.shotId === data.shotId) this.activeShot = null;
    this.onEvent(evt, data);
  }

  // ---------- Затвор ----------

  arm(shotId) {
    if (!this.source) return;
    const seriesId = newSeriesId();
    this.activeShot = { shotId, seriesId };
    this.source.arm(shotId, seriesId);
  }

  burst(shotId) {
    this.source?.burst(shotId);
    this.platform.haptic('burst');
  }

  async release(shotId, kind) {
    const src = this.source;
    if (!src) return;
    if (kind === 'burst') { src.stop(shotId); return; }
    const still = this.still;
    if (!still) { src.single(shotId, false); return; }
    src.single(shotId, true);
    this.onEvent('still-start', { shotId });
    const blob = await still.take();
    this.onEvent('still-end', { shotId, ok: !!blob });
    src.still(shotId, blob);
  }

  // ---------- Управление ----------

  async switchFacing() {
    return this.start(this.facing === 'environment' ? 'user' : 'environment');
  }

  async setZoom(z) {
    if (!this.caps.zoom || !this.track) return;
    const { min, max } = this.caps.zoom;
    const v = Math.min(max, Math.max(min, z));
    this._zoomWanted = v;
    if (this._zoomBusy) return;
    this._zoomBusy = true;
    try {
      while (this._zoomWanted != null) {
        const want = this._zoomWanted;
        this._zoomWanted = null;
        await this.track.applyConstraints({ advanced: [{ zoom: want }] }).catch(() => {});
      }
    } finally { this._zoomBusy = false; }
  }

  get zoom() { return this.settings.zoom || 1; }

  async setTorch(on) {
    if (!this.caps.torch || !this.track) return false;
    await this.track.applyConstraints({ advanced: [{ torch: on }] });
    return true;
  }

  focusSupported() { return this.track ? this.platform.focusSupported(this.track) : false; }

  async focusAt(x, y) {
    if (!this.focusSupported()) return false;
    await this.platform.focusAt(this.track, x, y).catch(() => {});
    return true;
  }

  stop() {
    this.generation++;
    this._teardown();
  }

  _teardown() {
    if (this.activeShot && this.source) this.source.stop(this.activeShot.shotId);
    this.activeShot = null;
    this.source?.close();
    this.source = null;
    this.still = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    if (this.video) this.video.srcObject = null;
  }
}

function waitDims(v) {
  if (v.videoWidth) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { v.removeEventListener('loadedmetadata', done); v.removeEventListener('resize', done); resolve(); };
    v.addEventListener('loadedmetadata', done);
    v.addEventListener('resize', done);
    setTimeout(done, 3000);
  });
}

function orientationMatches(src, video) {
  return new Promise((resolve) => {
    const check = (m) => {
      if (m.rotation) return resolve(false);
      const a = m.displayWidth >= m.displayHeight;
      const b = video.videoWidth >= video.videoHeight;
      resolve(a === b || !video.videoWidth);
    };
    if (src.frameInfo) return check(src.frameInfo);
    const off = src.on((evt, data) => { if (evt === 'frame-info') { off(); check(data); } });
    // Ни одного кадра за 2,5 с — источник нерабочий, берём запасной.
    setTimeout(() => { off(); resolve(false); }, 2500);
  });
}

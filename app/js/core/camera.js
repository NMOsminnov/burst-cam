// Камера: поток, превью, источник кадров, затвор, объективы, режимы, зум, фонарик, фокус.
import { openStream, measureFps, stepDown, probeModes } from '../platform/stream.js';
import { describeLenses } from '../platform/lenses.js';
import { stillStatus, photoMax } from '../platform/still.js';
import { pickDefaultMode, sameMode } from './modes.js';
import { WorkerSource, MainSource } from './sources.js';
import { newSeriesId } from './scheduler.js';
import { MIN_STREAM_FPS, STILL_GAIN } from './config.js';
import { jpegQuality, lensKey, saveSettings } from './settings.js';

export class Camera {
  constructor({ video, platform, pool, settings, onEvent = () => {}, status = () => {} }) {
    this.video = video;
    this.platform = platform;
    this.pool = pool;
    this.prefs = settings;
    this.onEvent = onEvent;
    this.status = status;
    this.facing = settings.facing || 'environment';
    this.stream = null;
    this.track = null;
    this.source = null;
    this.still = null;
    this.caps = {};
    this.fps = 30;
    this.starting = null;
    this.activeShot = null;
    this.generation = 0;
    this.lenses = { lenses: [], backs: [], ultraKnown: false };
    this.modes = null; // режимы потока текущего объектива (после опроса)
  }

  get settings() { return this.track ? this.track.getSettings() : {}; }

  get deviceId() { return this.facing === 'environment' ? this.prefs.deviceId : null; }

  get key() { return lensKey(this.facing, this.deviceId); }

  currentLens() {
    const id = this.settings.deviceId;
    return this.lenses.lenses.find((l) => l.deviceId === id) || null;
  }

  info() {
    const s = this.settings;
    const lens = this.currentLens();
    return {
      platform: this.platform.label,
      source: this.source?.kind || '—',
      width: s.width, height: s.height,
      fps: Math.round(this.fps),
      still: this.still ? { width: this.still.width, height: this.still.height, mode: this.still.mode, modes: this.still.modes } : null,
      tapMode: this.prefs.tapMode,
      stillModes: this.stillCaps?.modes || null,
      stillReason: this.still ? '' : this.prefs.tapMode === 'stream' ? 'выбран кадр потока'
        : this._stillPending ? 'проверяю…'
        : this.stillCaps ? 'авто: родное фото не крупнее кадра потока — снимаю мгновенно'
        : stillStatus.reason,
      quality: this.prefs.quality,
      encoders: this.pool.mode === 'main' ? 'главный поток' : `${this.pool.workers.length} воркера`,
      budgetMB: Math.round(this.platform.budget() / 1048576),
      zoom: this.caps.zoom ? { min: this.caps.zoom.min, max: this.caps.zoom.max } : null,
      torch: !!this.caps.torch,
      facing: s.facingMode || this.facing,
      lens: lens ? { name: lens.name, short: lens.short, kind: lens.kind } : null,
      lenses: this.lenses.lenses.map((l) => ({ deviceId: l.deviceId, name: l.name, short: l.short, kind: l.kind, facing: l.facing })),
      streamMode: this.prefs.streamMode[this.key] || null,
    };
  }

  start(facing = this.facing) {
    if (this.starting) return this.starting.then(() => this._start(facing));
    this.starting = this._start(facing).finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start(facing) {
    const gen = ++this.generation;
    this._teardown();
    this.facing = facing;
    this.modes = null;
    this.status('Включаю камеру…');
    let opened;
    try {
      opened = await openStream({ facing, deviceId: this.deviceId, mode: this.prefs.streamMode[this.key] || this.prefs.autoMode[this.key] || null, status: this.status });
    } catch (e) {
      // Выбранный объектив пропал (другой телефон, сброс разрешений) — берём какой дадут.
      if (this.deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
        this.prefs.deviceId = null;
        saveSettings(this.prefs);
        opened = await openStream({ facing, status: this.status });
      } else throw e;
    }
    const { stream, track, caps, fromCache } = opened;
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
    await this._refreshLenses();
    // Вернуть приближение, с которым снимали этим объективом в прошлый раз.
    const z = this.prefs.zoom[this.key];
    if (z && this.caps.zoom) await this.setZoom(z, { save: false });
    this.status('');
    this.onEvent('ready', this.info());

    // Фоном: реальная частота и родной снимок.
    this._tune(gen, fromCache).catch(() => {});
  }

  async _refreshLenses() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      this.lenses = describeLenses(devs);
    } catch { /* нет списка — работаем с одной камерой */ }
  }

  async _tune(gen, fromCache) {
    let fps = await measureFps(this.video);
    const userMode = !!this.prefs.streamMode[this.key];
    for (let i = 0; fps != null && fps < MIN_STREAM_FPS * 0.8 && i < 2 && !fromCache && !userMode; i++) {
      if (gen !== this.generation) return;
      if (!(await stepDown(this.track, this.caps, this.facing, this.deviceId))) break;
      await waitDims(this.video);
      fps = await measureFps(this.video);
    }
    if (gen !== this.generation) return;
    if (fps) { this.fps = Math.min(60, fps); this.source?.setStream({ fps: this.fps }); }
    await this._autoProbe(gen);
    if (gen !== this.generation) return;
    await this._setupStill(gen);
    if (gen !== this.generation) return;
    this.onEvent('ready', this.info());
  }

  /**
   * Автоопрос режимов камеры (один раз на объектив, потом из кэша) и выбор режима, при котором
   * родной снимок крупнее всего: на части Android-камер размер фото зависит от режима потока.
   */
  async _autoProbe(gen) {
    if (!this.track) return;
    this.probing = true;
    this.onEvent('probe-start', {});
    try {
      const native = this.prefs.tapMode !== 'stream' && typeof ImageCapture !== 'undefined';
      const modes = await probeModes(this.track, this.caps, {
        cacheKey: 'v2:' + this.key + ':' + (this.settings.deviceId || '') + (native ? ':photo' : ''),
        photo: native ? (t) => photoMax(t) : null,
      });
      if (gen !== this.generation) return;
      this.modes = modes;
      this.onEvent('modes', { lens: this.currentLens()?.name, modes });
      if (this.prefs.streamMode[this.key]) return; // режим выбран вручную
      // По умолчанию: максимальная частота (в идеале 60 к/с), при ней — максимальное разрешение.
      const best = pickDefaultMode(modes);
      const st = this.settings;
      const cur = { width: Math.max(st.width, st.height), height: Math.min(st.width, st.height), fps: st.frameRate };
      if (best && !sameMode(best, cur)) {
        this.prefs.autoMode[this.key] = [best.width, best.height, best.fps || undefined];
        saveSettings(this.prefs);
        this.onEvent('auto-mode', { from: cur, to: best });
        const portrait = st.height > st.width;
        await this.track.applyConstraints({ width: { ideal: portrait ? best.height : best.width }, height: { ideal: portrait ? best.width : best.height }, frameRate: { ideal: best.fps || 30 } }).catch(() => {});
        await waitDims(this.video);
        const fps = await measureFps(this.video);
        if (fps) { this.fps = Math.min(60, fps); this.source?.setStream({ fps: this.fps }); }
      }
    } catch (e) {
      this.onEvent('probe-error', { message: e.message });
    } finally {
      this.probing = false;
      this.onEvent('probe-end', {});
    }
  }

  async _setupStill(gen = this.generation) {
    this.still = null;
    this.stillCaps = null;
    if (this.prefs.tapMode === 'stream' || !this.track) return;
    this._stillPending = true;
    try {
      const still = await this.platform.setupStill(this.track, { mode: this.prefs.stillSize });
      if (gen !== this.generation) return;
      this.stillCaps = still;
      // «Авто»: родной снимок — только если он заметно крупнее кадра потока. Иначе мгновенный
      // кадр в момент касания: то же разрешение, но без задержки 0,4–0,9 с (а с ней — смаза).
      this.still = still && (this.prefs.tapMode === 'native' || still.gain >= STILL_GAIN) ? still : null;
    } finally { this._stillPending = false; }
  }

  async _attachSource(gen) {
    const budget = this.platform.budget();
    const quality = jpegQuality(this.prefs);
    for (const plan of this.platform.sourcePlan()) {
      if (gen !== this.generation) return;
      const ports = this.pool.freshPorts();
      try {
        let src;
        if (plan === 'worker:readable') {
          if (typeof window.MediaStreamTrackProcessor !== 'function') continue;
          src = await WorkerSource.create({ track: this.track, how: 'readable', ports, budget, fps: this.fps, quality });
        } else if (plan === 'worker:track') {
          src = await WorkerSource.create({ track: this.track, how: 'track', ports, budget, fps: this.fps, quality });
        } else {
          src = MainSource.create({ video: this.video, ports, budget, fps: this.fps, quality });
        }
        if (src instanceof WorkerSource && !(await orientationMatches(src, this.video))) {
          // Кадры процессора повёрнуты не так, как превью (или не идут): надёжнее брать их из <video>.
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
    if (!this.source) return false;
    const seriesId = newSeriesId();
    this.activeShot = { shotId, seriesId };
    this.source.arm(shotId, seriesId);
    // Родной снимок запускаем сразу при нажатии, а не при отпускании: он и так снимается
    // с задержкой 0,4–0,9 с, и каждая лишняя доля секунды — риск смаза.
    if (this.still) {
      this._stillShot = { shotId, promise: this.still.take() };
      this.onEvent('still-start', { shotId });
    }
    return true;
  }

  burst(shotId) {
    this.source?.burst(shotId);
    this.platform.haptic('burst');
  }

  async release(shotId, kind) {
    const src = this.source;
    if (!src) return;
    const pending = this._stillShot && this._stillShot.shotId === shotId ? this._stillShot : null;
    this._stillShot = null;
    if (kind === 'burst') {
      // Серия идёт из потока; начатый родной снимок не нужен.
      src.stop(shotId);
      if (pending) pending.promise.then(() => this.onEvent('still-end', { shotId, ok: false, dropped: true }));
      return;
    }
    if (!pending) { src.single(shotId, false); return; }
    // Кадр потока уже взят в момент касания и ждёт родной снимок как образец ориентации.
    src.single(shotId, true);
    const blob = await pending.promise;
    this.onEvent('still-end', { shotId, ok: !!blob });
    if (this.source === src) src.still(shotId, blob);
  }

  // ---------- Объективы и режимы ----------

  async switchFacing() {
    this.prefs.facing = this.facing === 'environment' ? 'user' : 'environment';
    saveSettings(this.prefs);
    return this.start(this.prefs.facing);
  }

  /** Выбрать объектив по deviceId (из this.lenses). */
  async selectLens(deviceId) {
    const lens = this.lenses.lenses.find((l) => l.deviceId === deviceId);
    if (!lens) return;
    this.onEvent('setting', { lens: lens.name, label: lens.label });
    this.prefs.facing = lens.facing === 'user' ? 'user' : 'environment';
    if (lens.facing !== 'user') this.prefs.deviceId = deviceId;
    saveSettings(this.prefs);
    return this.start(this.prefs.facing);
  }

  /** Режимы потока текущего объектива (опрос с миганием превью, результат кэшируется). */
  async listModes() {
    return this.modes || [];
  }

  /** mode: [длинная, короткая] или null (автоподбор). */
  async setStreamMode(mode) {
    this.onEvent('setting', { streamMode: mode });
    if (mode) this.prefs.streamMode[this.key] = mode;
    else { delete this.prefs.streamMode[this.key]; delete this.prefs.autoMode[this.key]; }
    saveSettings(this.prefs);
    return this.start(this.facing);
  }

  async setTapMode(tapMode, stillSize = this.prefs.stillSize) {
    this.onEvent('setting', { tapMode, stillSize });
    this.prefs.tapMode = tapMode;
    this.prefs.stillSize = stillSize;
    saveSettings(this.prefs);
    await this._setupStill();
    this.onEvent('ready', this.info());
  }

  setQuality(q) {
    this.prefs.quality = q;
    this.onEvent('setting', { quality: q });
    saveSettings(this.prefs);
    this.source?.setStream({ quality: jpegQuality(this.prefs) });
    this.onEvent('ready', this.info());
  }

  // ---------- Управление ----------

  async setZoom(z, { save = true } = {}) {
    if (!this.caps.zoom || !this.track) return;
    const { min, max } = this.caps.zoom;
    const v = Math.min(max, Math.max(min, z));
    if (save) {
      this.prefs.zoom[this.key] = v;
      clearTimeout(this._zoomSave);
      this._zoomSave = setTimeout(() => { saveSettings(this.prefs); this.onEvent('setting', { zoom: v }); }, 600);
    }
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

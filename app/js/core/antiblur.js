// Защита от смаза. В помещении автоэкспозиция камеры удлиняет выдержку до 1/25 с и дольше:
// кадр смазывается от дрожания рук (тем сильнее, чем больше зум), а частота падает ниже 30 к/с.
// Если камера отдаёт браузеру ручную экспозицию (Chrome на Android: exposureMode 'manual',
// exposureTime, iso), держим выдержку не длиннее предела, а яркость добираем светочувствительностью
// (ISO) — по замеру яркости превью, как это делает сама камера. Цена — больше шума в темноте.
// На свету камера и так снимает быстрее предела — тогда защита возвращает её автоматике.
// Если ISO на этом телефоне не действует (кадр не светлеет), защита выключается и пишет в журнал.

const UNIT = 1e4; // exposureTime по спецификации — в единицах 100 мкс: 1/30 с = 333
const TICK_MS = 700;

/** Предел выдержки: 1/30 с; при зуме от 2× дрожание заметнее — 1/60 с. */
export const exposureLimit = (zoom = 1) => (zoom >= 2 ? UNIT / 60 : UNIT / 30);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Поддерживает ли дорожка ручную выдержку и ISO. */
export function antiblurSupported(caps) {
  return !!(caps && Array.isArray(caps.exposureMode) && caps.exposureMode.includes('manual')
    && caps.exposureMode.includes('continuous') && caps.exposureTime && caps.iso);
}

export class ExposureGuard {
  constructor({ track, video, caps, onEvent = () => {} }) {
    this.track = track;
    this.video = video;
    this.caps = caps;
    this.onEvent = onEvent;
    this.state = 'auto'; // auto — автоматика камеры; manual — держим выдержку сами; off — недоступно
    this.timer = null;
    this.busy = false;
    this.cooldownUntil = 0;
    this.canvas = null;
  }

  start() {
    if (!antiblurSupported(this.caps)) { this.state = 'off'; return false; }
    this.timer = setInterval(() => this._tick().catch((e) => this.onEvent('antiblur-error', { message: e.message })), TICK_MS);
    return true;
  }

  /** Остановить и вернуть камеру автоматике (если дорожка ещё жива). */
  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.state === 'manual') await this._toAuto('stop');
  }

  info() {
    return { state: this.state, exposureTime: this.exp ?? null, iso: this.iso ?? null, limit: this.limit ?? null };
  }

  async _tick() {
    if (this.busy || this.track.readyState !== 'live' || document.visibilityState === 'hidden') return;
    this.busy = true;
    try {
      const s = this.track.getSettings();
      const limit = Math.max(this.caps.exposureTime.min || 1, exposureLimit(s.zoom || 1));
      if (this.state === 'auto') {
        if (Date.now() < this.cooldownUntil) return;
        if (s.exposureMode !== 'manual' && s.exposureTime > limit * 1.05) await this._engage(s, limit);
      } else if (this.state === 'manual') {
        await this._adjust(limit);
      }
    } finally { this.busy = false; }
  }

  async _engage(s, limit) {
    const target = this._luma();
    if (target == null) return;
    const isoCaps = this.caps.iso;
    // Свет, который собирала камера: выдержка × ISO. Сохраняем его, укорачивая выдержку.
    const iso = clamp((s.iso || 100) * (s.exposureTime / limit), isoCaps.min, isoCaps.max);
    this.target = clamp(target, 40, 170);
    this.limit = limit;
    if (!(await this._apply(limit, iso))) { this.state = 'off'; this.onEvent('antiblur-unavailable', { reason: 'applyConstraints отклонён' }); return; }
    this.state = 'manual';
    this.base = null; // яркость и ISO после первого шага — для проверки, что ISO вообще действует
    this.onEvent('antiblur-on', { fromExposure: s.exposureTime, limit: Math.round(limit), iso: Math.round(iso), luma: Math.round(target) });
  }

  async _adjust(limit) {
    const l = this._luma();
    if (l == null) return;
    const isoCaps = this.caps.iso;
    let iso = this.iso;
    if (Math.abs(limit - this.limit) > 1) { iso = clamp(iso * (this.exp / limit), isoCaps.min, isoCaps.max); this.limit = limit; }
    if (!this.base) this.base = { luma: l, iso };
    // ISO подняли вдвое, а кадр почти не посветлел — камера ручной ISO не слушает.
    if (iso >= this.base.iso * 2 && l < this.base.luma * 1.15 && l < this.target * 0.9) {
      await this._toAuto('iso-ignored');
      this.state = 'off';
      this.onEvent('antiblur-unavailable', { reason: 'ISO не меняет яркость', iso: Math.round(iso), luma: Math.round(l) });
      return;
    }
    // Светло: ISO на минимуме, а кадр всё равно ярче нужного — камера справится сама.
    if (iso <= isoCaps.min * 1.05 && l > this.target * 1.25) { await this._toAuto('bright'); return; }
    const ratio = this.target / Math.max(l, 1);
    if (Math.abs(ratio - 1) < 0.08 && limit === this.exp) return;
    const next = clamp(iso * clamp(ratio ** 0.8, 0.5, 2), isoCaps.min, isoCaps.max);
    await this._apply(limit, next);
  }

  async _apply(exposureTime, iso) {
    try {
      await this.track.applyConstraints({ advanced: [{ exposureMode: 'manual', exposureTime, iso: Math.round(iso) }] });
      this.exp = exposureTime;
      this.iso = iso;
      return true;
    } catch { return false; }
  }

  async _toAuto(why) {
    this.state = 'auto';
    this.cooldownUntil = Date.now() + 3000;
    this.exp = this.iso = null;
    if (this.track.readyState === 'live') {
      await this.track.applyConstraints({ advanced: [{ exposureMode: 'continuous' }] }).catch(() => {});
    }
    this.onEvent('antiblur-off', { why });
  }

  /** Средняя яркость превью (0–255) по уменьшенной копии кадра. */
  _luma() {
    const v = this.video;
    if (!v || !v.videoWidth) return null;
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = 32; this.canvas.height = 24;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    try {
      this.ctx.drawImage(v, 0, 0, 32, 24);
      const d = this.ctx.getImageData(0, 0, 32, 24).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      return sum / (d.length / 4);
    } catch { return null; }
  }
}

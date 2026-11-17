// Состояние галереи в памяти: список фото (без полноразмерных файлов) + подписки.
import { listPhotos, deletePhotos, groupSeries } from '../core/store.js';

export class Library {
  constructor() {
    this.photos = []; // новые сверху
    this.listeners = new Set();
    this._groups = null;
    this._scheduled = false;
  }

  async load() {
    this.photos = await listPhotos();
    this._changed();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  add(meta) {
    // Вставка с сохранением порядка (id сортируются как время).
    const arr = this.photos;
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].id > meta.id) lo = mid + 1; else hi = mid;
    }
    if (arr[lo] && arr[lo].id === meta.id) arr[lo] = meta; else arr.splice(lo, 0, meta);
    this._changed();
  }

  async remove(ids) {
    const set = new Set(ids);
    await deletePhotos(ids);
    this.photos = this.photos.filter((p) => !set.has(p.id));
    this._changed();
  }

  get latest() { return this.photos[0] || null; }

  groups() {
    if (!this._groups) this._groups = groupSeries(this.photos);
    return this._groups;
  }

  series(seriesId) {
    return this.groups().find((g) => g.seriesId === seriesId) || null;
  }

  totalBytes() {
    return this.photos.reduce((s, p) => s + (p.bytes || 0), 0);
  }

  _changed() {
    this._groups = null;
    if (this._scheduled) return;
    this._scheduled = true;
    // Серия даёт десятки событий в секунду — перерисовываем не чаще кадра.
    requestAnimationFrame(() => {
      this._scheduled = false;
      for (const fn of this.listeners) fn();
    });
  }
}

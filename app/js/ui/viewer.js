// Полноэкранный просмотр: листание свайпом, щипок и двойное касание для увеличения,
// смахивание вниз — закрыть, одиночное касание — спрятать/показать кнопки.
import { getBlob } from '../core/store.js';
import { thumbUrl, forgetThumbs, confirmDelete, toast, nav, mb, mp, when } from './util.js';
import { sharePhotos } from './share.js';

const MAX_SCALE = 6;
const DOUBLE_TAP_MS = 260;

export class Viewer {
  constructor({ el, library, openSeries }) {
    this.el = el;
    this.lib = library;
    this.openSeries = openSeries;
    this.track = el.querySelector('[data-ref="track"]');
    this.ref = (n) => el.querySelector(`[data-ref="${n}"]`);
    this.list = [];
    this.index = 0;
    this.context = 'root';
    this.slides = [-1, 0, 1].map((off) => this._makeSlide(off));
    this.blobs = new Map(); // id → Blob (полноразмерные, для 3 видимых слайдов)
    this.urls = new Map(); // id → objectURL
    this.z = { s: 1, x: 0, y: 0 };
    el.addEventListener('click', (e) => this._onAction(e));
    this._bindGestures();
    addEventListener('resize', () => { if (!this.el.hidden) this._layout(false); });
    library.on(() => this._syncWithLibrary());
  }

  _makeSlide(off) {
    const s = document.createElement('div');
    s.className = 'slide';
    s.innerHTML = '<div class="zoomer"><img alt="" draggable="false"></div>';
    s.zoomer = s.firstChild;
    s.img = s.zoomer.firstChild;
    s.off = off;
    s.zoomer.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;transform-origin:0 0';
    this.track.appendChild(s);
    return s;
  }

  open(list, index, context) {
    this.list = list.slice();
    this.index = Math.max(0, Math.min(index, list.length - 1));
    this.context = context;
    this.el.hidden = false;
    this.el.classList.remove('bare');
    this.ref('info').hidden = true;
    this.el.style.opacity = '';
    this._layout(false);
    nav.open(this);
  }

  hide() {
    this.el.hidden = true;
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
    this.blobs.clear();
    for (const s of this.slides) { s.img.removeAttribute('src'); s.dataset.id = ''; }
  }

  get current() { return this.list[this.index] || null; }

  /** Расставить слайды вокруг текущего индекса. */
  _layout(animate) {
    const W = this.el.clientWidth;
    this.track.style.transition = animate ? 'transform 0.26s cubic-bezier(0.2,0.8,0.2,1)' : 'none';
    this.track.style.transform = 'translate3d(0,0,0)';
    const keep = new Set();
    for (const s of this.slides) {
      const i = this.index + s.off;
      const m = this.list[i];
      s.style.transform = `translate3d(${s.off * W}px,0,0)`;
      s.hidden = !m;
      if (!m) continue;
      keep.add(m.id);
      if (s.dataset.id !== m.id) {
        s.dataset.id = m.id;
        s.img.src = this.urls.get(m.id) || thumbUrl(m);
        this._loadFull(m, s);
      }
    }
    // Освобождаем полноразмерные файлы, ушедшие из окна.
    for (const [id, u] of this.urls) if (!keep.has(id)) { URL.revokeObjectURL(u); this.urls.delete(id); this.blobs.delete(id); }
    this._resetZoom(false);
    this._updateChrome();
  }

  async _loadFull(meta, slide) {
    if (this.urls.has(meta.id)) { slide.img.src = this.urls.get(meta.id); return; }
    const blob = await getBlob(meta.id);
    if (!blob || slide.dataset.id !== meta.id || this.el.hidden) return;
    const url = URL.createObjectURL(blob);
    this.urls.set(meta.id, url);
    this.blobs.set(meta.id, blob);
    const pre = new Image();
    pre.src = url;
    try { await pre.decode(); } catch { /* покажем как есть */ }
    if (slide.dataset.id === meta.id) slide.img.src = url;
  }

  _updateChrome() {
    const m = this.current;
    if (!m) return;
    this.ref('pos').textContent = this.list.length > 1 ? `${this.index + 1} из ${this.list.length}` : when(m.createdAt);
    const chip = this.ref('serieschip');
    const g = this.context === 'root' ? this.lib.series(m.seriesId) : null;
    if (g && g.items.length > 1) {
      chip.hidden = false;
      chip.innerHTML = `<svg><use href="#i-stack"/></svg>Серия · ${g.items.length} фото`;
    } else chip.hidden = true;
    if (!this.ref('info').hidden) this._renderInfo();
  }

  _renderInfo() {
    const m = this.current;
    const box = this.ref('info');
    box.innerHTML = `<dl>
      <dt>Снято</dt><dd>${when(m.createdAt)}</dd>
      <dt>Размер</dt><dd>${m.width} × ${m.height} (${mp(m.width, m.height)})</dd>
      <dt>Файл</dt><dd>${mb(m.bytes)} · JPEG</dd>
      <dt>Источник</dt><dd>${m.source === 'still' ? 'полный снимок камеры' : 'кадр видеопотока'}</dd>
      <dt>Обработка</dt><dd>${m.encodeMs ?? '—'} мс</dd>
      ${m.idx > 0 || this.lib.series(m.seriesId)?.items.length > 1 ? `<dt>Кадр серии</dt><dd>№ ${m.idx + 1}</dd>` : ''}
    </dl>`;
  }

  _syncWithLibrary() {
    if (this.el.hidden) return;
    const alive = new Set(this.lib.photos.map((p) => p.id));
    const before = this.list.length;
    const cur = this.current;
    this.list = this.list.filter((m) => alive.has(m.id));
    if (!this.list.length) { nav.back(); return; }
    if (this.list.length !== before) {
      const i = cur ? this.list.findIndex((m) => m.id === cur.id) : -1;
      this.index = i >= 0 ? i : Math.min(this.index, this.list.length - 1);
      for (const s of this.slides) s.dataset.id = '';
      this._layout(false);
    }
  }

  go(delta) {
    const next = this.index + delta;
    if (next < 0 || next >= this.list.length) { this._layout(true); return; }
    const W = this.el.clientWidth;
    this.track.style.transition = 'transform 0.26s cubic-bezier(0.2,0.8,0.2,1)';
    this.track.style.transform = `translate3d(${-delta * W}px,0,0)`;
    const done = () => {
      this.track.removeEventListener('transitionend', done);
      clearTimeout(t);
      this.index = next;
      // Слайды «переезжают» вместе с картинками: соседний становится текущим без перезагрузки,
      // ушедший за край переходит на другую сторону.
      for (const s of this.slides) {
        s.off -= delta;
        if (s.off < -1) s.off = 1;
        if (s.off > 1) s.off = -1;
      }
      this.slides.sort((a, b) => a.off - b.off);
      this._layout(false);
    };
    const t = setTimeout(done, 320);
    this.track.addEventListener('transitionend', done);
  }

  // ---------- Масштаб ----------

  _cur() { return this.slides.find((s) => s.off === 0); }

  _fit() {
    const s = this._cur();
    const W = this.el.clientWidth, H = this.el.clientHeight;
    const m = this.current;
    const iw = m?.width || W, ih = m?.height || H;
    const k = Math.min(W / iw, H / ih);
    const dw = iw * k, dh = ih * k;
    return { W, H, dw, dh, ox: (W - dw) / 2, oy: (H - dh) / 2, s };
  }

  _clamp(z) {
    const f = this._fit();
    const s = Math.min(MAX_SCALE, Math.max(1, z.s));
    const ax = (len, view, o) => {
      const scaled = len * s;
      if (scaled <= view) return [(view - scaled) / 2 - o * s, (view - scaled) / 2 - o * s];
      return [view - (o + len) * s, -o * s];
    };
    const [x0, x1] = ax(f.dw, f.W, f.ox);
    const [y0, y1] = ax(f.dh, f.H, f.oy);
    return { s, x: Math.min(x1, Math.max(x0, z.x)), y: Math.min(y1, Math.max(y0, z.y)) };
  }

  _applyZoom(z, animate) {
    this.z = z;
    const zo = this._cur()?.zoomer;
    if (!zo) return;
    zo.style.transition = animate ? 'transform 0.22s cubic-bezier(0.2,0.8,0.2,1)' : 'none';
    zo.style.transform = `translate3d(${z.x}px,${z.y}px,0) scale(${z.s})`;
  }

  _resetZoom(animate) {
    for (const s of this.slides) { s.zoomer.style.transition = 'none'; s.zoomer.style.transform = ''; }
    this.z = { s: 1, x: 0, y: 0 };
    if (animate) this._applyZoom(this.z, true);
  }

  _zoomAt(px, py, s1) {
    const { s, x, y } = this.z;
    const k = s1 / s;
    return { s: s1, x: px - (px - x) * k, y: py - (py - y) * k };
  }

  // ---------- Жесты ----------

  _bindGestures() {
    const el = this.el;
    const pts = new Map();
    let g = null; // текущий жест
    let lastTap = 0;
    let tapTimer = null;

    const isChrome = (t) => t.closest('.chrome');

    el.addEventListener('pointerdown', (e) => {
      if (isChrome(e.target) || !this.ref('info').hidden && e.target.closest('.viewer-info')) return;
      el.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        g = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), z0: { ...this.z }, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      } else if (pts.size === 1) {
        g = { type: 'pending', x0: e.clientX, y0: e.clientY, t0: performance.now(), z0: { ...this.z }, moved: false };
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId) || !g) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (g.type === 'pinch' && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const s1 = Math.min(MAX_SCALE * 1.2, Math.max(0.6, g.z0.s * (d / g.d0)));
        this.z = g.z0;
        const z = this._zoomAt(g.mx, g.my, s1);
        z.x += mx - g.mx; z.y += my - g.my;
        this._applyZoom(z, false);
        return;
      }
      const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      if (g.type === 'pending') {
        if (Math.hypot(dx, dy) < 8) return;
        g.moved = true;
        if (this.z.s > 1.01) g.type = 'pan';
        else if (Math.abs(dx) > Math.abs(dy)) g.type = 'page';
        else if (dy > 0) g.type = 'dismiss';
        else g.type = 'none';
      }
      if (g.type === 'pan') {
        this._applyZoom(this._clamp({ s: g.z0.s, x: g.z0.x + dx, y: g.z0.y + dy }), false);
      } else if (g.type === 'page') {
        const edge = (dx > 0 && this.index === 0) || (dx < 0 && this.index === this.list.length - 1);
        this.track.style.transition = 'none';
        this.track.style.transform = `translate3d(${edge ? dx / 3 : dx}px,0,0)`;
      } else if (g.type === 'dismiss') {
        this.track.style.transition = 'none';
        this.track.style.transform = `translate3d(0,${dy}px,0) scale(${Math.max(0.8, 1 - dy / 1600)})`;
        el.style.background = `rgba(0,0,0,${Math.max(0.2, 1 - dy / 500)})`;
        el.classList.add('bare');
      }
    });

    const end = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (!g) return;
      if (g.type === 'pinch') {
        if (pts.size === 1) {
          // Один палец остался — продолжаем как панораму.
          const [p] = [...pts.values()];
          g = { type: 'pan', x0: p.x, y0: p.y, z0: { ...this.z }, moved: true };
        } else {
          g = null;
          if (this.z.s < 1.02) this._resetZoom(true);
          else this._applyZoom(this._clamp(this.z), true);
        }
        return;
      }
      if (pts.size) return;
      const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      const dt = Math.max(1, performance.now() - (g.t0 || 0));
      const W = el.clientWidth;
      if (g.type === 'page') {
        const v = dx / dt;
        if (dx < -W * 0.18 || v < -0.45) this.go(1);
        else if (dx > W * 0.18 || v > 0.45) this.go(-1);
        else this._layout(true);
      } else if (g.type === 'dismiss') {
        el.style.background = '';
        if (dy > 110 || dy / dt > 0.5) { this.track.style.transform = ''; nav.back(); }
        else { this.track.style.transition = 'transform 0.22s'; this.track.style.transform = ''; el.classList.remove('bare'); }
      } else if (g.type === 'pending' && !g.moved && e.type === 'pointerup') {
        const now = performance.now();
        const x = e.clientX, y = e.clientY;
        if (now - lastTap < DOUBLE_TAP_MS) {
          clearTimeout(tapTimer);
          lastTap = 0;
          if (this.z.s > 1.01) this._resetZoom(true);
          else this._applyZoom(this._clamp(this._zoomAt(x, y, 2.5)), true);
        } else {
          lastTap = now;
          tapTimer = setTimeout(() => {
            this.el.classList.toggle('bare');
          }, DOUBLE_TAP_MS);
        }
      }
      g = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    // Колёсико/тачпад на компьютере.
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        const s1 = this.z.s * Math.exp(-e.deltaY / 300);
        const z = this._zoomAt(e.clientX, e.clientY, Math.max(1, Math.min(MAX_SCALE, s1)));
        this._applyZoom(this._clamp(z), false);
      }
    }, { passive: false });
    addEventListener('keydown', (e) => {
      if (this.el.hidden) return;
      if (e.key === 'ArrowRight') this.go(1);
      else if (e.key === 'ArrowLeft') this.go(-1);
      else if (e.key === 'Escape') nav.back();
      else if (e.key === 'Delete') this._delete();
    });
  }

  async _onAction(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'back') nav.back();
    else if (act === 'info') {
      const box = this.ref('info');
      box.hidden = !box.hidden;
      if (!box.hidden) this._renderInfo();
    } else if (act === 'share') {
      const m = this.current;
      if (m) await sharePhotos([m], this.blobs);
    } else if (act === 'delete') this._delete();
    else if (act === 'open-series') {
      const m = this.current;
      if (m) this.openSeries(m.seriesId);
    }
  }

  async _delete() {
    const m = this.current;
    if (!m) return;
    if (!(await confirmDelete('Удалить это фото? Это действие нельзя отменить.', 'Удалить фото'))) return;
    await this.lib.remove([m.id]);
    forgetThumbs([m.id]);
    toast('Фото удалено', 1400);
  }
}

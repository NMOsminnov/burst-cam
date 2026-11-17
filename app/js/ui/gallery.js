// Галерея (все снимки, серии свёрнуты в одну плитку) и экран серии (кадры одной серии).
// Один класс, два экземпляра: mode = 'root' | 'series'.
import { thumbUrl, forgetThumbs, confirmDelete, toast, nav, mb, when } from './util.js';
import { sharePhotos } from './share.js';

const LONG_PRESS_MS = 420;

export class GalleryView {
  constructor({ el, mode, library, openViewer, openSeries }) {
    this.el = el;
    this.mode = mode;
    this.lib = library;
    this.openViewer = openViewer;
    this.openSeries = openSeries;
    this.seriesId = null;
    this.selecting = false;
    this.selected = new Set(); // ключи плиток
    this.tiles = []; // {key, ids, metas, cover, count}
    this.ref = (n) => el.querySelector(`[data-ref="${n}"]`);
    this.grid = this.ref('grid');
    this.io = new IntersectionObserver((ents) => {
      for (const e of ents) {
        if (!e.isIntersecting) continue;
        const img = e.target;
        this.io.unobserve(img);
        const tile = this.tiles[Number(img.dataset.i)];
        if (tile) img.src = thumbUrl(tile.cover);
      }
    }, { root: this.grid, rootMargin: '400px 0px' });

    el.addEventListener('click', (e) => this._onAction(e));
    this._bindGrid();
    library.on(() => { if (!this.el.hidden) this.render(); });
  }

  show(seriesId = null) {
    this.seriesId = seriesId;
    this.selecting = false;
    this.selected.clear();
    this.el.hidden = false;
    this.render();
    this.grid.scrollTop = 0;
    nav.open(this);
  }

  hide() {
    this.el.hidden = true;
    this._setSelecting(false);
  }

  _collect() {
    if (this.mode === 'root') {
      return this.lib.groups().map((g) => ({ key: g.seriesId, ids: g.items.map((m) => m.id), metas: g.items, cover: g.cover, count: g.items.length }));
    }
    const g = this.lib.series(this.seriesId);
    return g ? g.items.map((m) => ({ key: m.id, ids: [m.id], metas: [m], cover: m, count: 1 })) : [];
  }

  render() {
    const tiles = this._collect();
    if (this.mode === 'series' && !tiles.length) {
      // Серию удалили целиком — уходим назад.
      if (!this.el.hidden) nav.back();
      return;
    }
    this.tiles = tiles;
    for (const k of [...this.selected]) if (!tiles.some((t) => t.key === k)) this.selected.delete(k);

    const total = tiles.reduce((s, t) => s + t.count, 0);
    if (this.mode === 'root') {
      this.ref('title').textContent = 'Галерея';
      this.ref('subtitle').textContent = total ? `${total} фото · ${mb(this.lib.totalBytes())}` : '';
    } else {
      this.ref('title').textContent = `Серия · ${total} фото`;
      this.ref('subtitle').textContent = tiles[0] ? when(tiles[0].cover.createdAt) : '';
    }
    this.ref('empty').hidden = total > 0;
    this.el.querySelector('[data-act="select"]').hidden = total === 0;

    // Перерисовка: переиспользуем узлы по ключу, чтобы не мигали картинки.
    const old = new Map([...this.grid.children].map((n) => [n.dataset.key, n]));
    const frag = document.createDocumentFragment();
    tiles.forEach((t, i) => {
      let node = old.get(t.key);
      if (node) old.delete(t.key);
      else node = this._makeTile(t);
      node.dataset.i = i;
      node.querySelector('img').dataset.i = i;
      const badge = node.querySelector('.badge');
      if (t.count > 1) {
        badge.hidden = false;
        badge.lastChild.textContent = String(t.count);
      } else badge.hidden = true;
      node.classList.toggle('sel', this.selected.has(t.key));
      frag.appendChild(node);
    });
    for (const n of old.values()) { const img = n.querySelector('img'); this.io.unobserve(img); }
    this.grid.replaceChildren(frag);
    this._updateSelBar();
  }

  _makeTile(t) {
    const node = document.createElement('div');
    node.className = 'tile';
    node.dataset.key = t.key;
    node.setAttribute('role', 'listitem');
    node.innerHTML = `<img alt="" decoding="async" draggable="false"><span class="badge" hidden><svg><use href="#i-stack"/></svg><span></span></span><span class="mark"><svg><use href="#i-check"/></svg></span>`;
    const img = node.querySelector('img');
    img.onload = () => img.classList.add('ok');
    this.io.observe(img);
    return node;
  }

  _bindGrid() {
    let timer = null;
    let start = null;
    let longFired = false;
    const tileOf = (e) => e.target.closest('.tile');
    this.grid.addEventListener('pointerdown', (e) => {
      const tile = tileOf(e);
      if (!tile) return;
      start = { x: e.clientX, y: e.clientY, tile };
      longFired = false;
      timer = setTimeout(() => {
        longFired = true;
        if (!this.selecting) this._setSelecting(true);
        this._toggle(tile);
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
    });
    const cancel = () => { clearTimeout(timer); timer = null; };
    this.grid.addEventListener('pointermove', (e) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) { cancel(); start = null; }
    });
    this.grid.addEventListener('pointercancel', () => { cancel(); start = null; });
    this.grid.addEventListener('pointerup', () => cancel());
    this.grid.addEventListener('contextmenu', (e) => e.preventDefault());
    this.grid.addEventListener('click', (e) => {
      const tile = tileOf(e);
      if (!tile || longFired) { longFired = false; return; }
      if (this.selecting) { this._toggle(tile); return; }
      const t = this.tiles[Number(tile.dataset.i)];
      if (!t) return;
      if (this.mode === 'root' && t.count > 1) { this.openSeries(t.key); return; }
      const list = this.tiles.map((x) => x.cover);
      this.openViewer(list, Number(tile.dataset.i), this.mode);
    });
  }

  _toggle(tile) {
    const key = tile.dataset.key;
    if (this.selected.has(key)) this.selected.delete(key); else this.selected.add(key);
    tile.classList.toggle('sel', this.selected.has(key));
    this._updateSelBar();
  }

  _setSelecting(on) {
    this.selecting = on;
    if (!on) this.selected.clear();
    this.el.classList.toggle('selecting', on);
    this.ref('selbar').hidden = !on;
    const b = this.el.querySelector('[data-act="select"]');
    b.textContent = on ? 'Готово' : 'Выбрать';
    for (const n of this.grid.children) n.classList.toggle('sel', this.selected.has(n.dataset.key));
    this._updateSelBar();
  }

  _selectedMetas() {
    return this.tiles.filter((t) => this.selected.has(t.key)).flatMap((t) => t.metas);
  }

  _updateSelBar() {
    const n = this._selectedMetas().length;
    this.ref('selcount').textContent = n ? `Выбрано: ${n}` : 'Выберите фото';
    this.el.querySelector('[data-act="delete"]').disabled = !n;
    this.el.querySelector('[data-act="share"]').disabled = !n;
    const all = this.el.querySelector('[data-act="all"]');
    all.textContent = this.tiles.length && this.selected.size === this.tiles.length ? 'Снять' : 'Все';
  }

  async _onAction(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'back') nav.back();
    else if (act === 'select') this._setSelecting(!this.selecting);
    else if (act === 'all') {
      if (this.selected.size === this.tiles.length) this.selected.clear();
      else this.tiles.forEach((t) => this.selected.add(t.key));
      for (const n of this.grid.children) n.classList.toggle('sel', this.selected.has(n.dataset.key));
      this._updateSelBar();
    } else if (act === 'share') {
      const metas = this._selectedMetas();
      if (metas.length > 60) { toast('За раз — не больше 60 фото'); return; }
      await sharePhotos(metas);
    } else if (act === 'delete') {
      const metas = this._selectedMetas();
      if (!metas.length) return;
      const allOfSeries = this.mode === 'series' && metas.length === this.tiles.length;
      const text = allOfSeries
        ? `Удалить всю серию (${metas.length} фото)? Это действие нельзя отменить.`
        : `Удалить ${metas.length} фото? Это действие нельзя отменить.`;
      if (!(await confirmDelete(text, metas.length > 1 ? `Удалить ${metas.length} фото` : 'Удалить фото'))) return;
      const ids = metas.map((m) => m.id);
      await this.lib.remove(ids);
      forgetThumbs(ids);
      this._setSelecting(false);
      toast(`Удалено: ${ids.length}`);
    }
  }
}

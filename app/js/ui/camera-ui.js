// Экран камеры: кнопка спуска (касание — фото, удержание — серия), счётчик серии,
// последняя миниатюра, смена камеры, зум щипком, фокус касанием, фонарик.
import { createPress } from '../core/press.js';
import { HOLD_MS, MIN_FREE_BYTES } from '../core/config.js';
import { thumbUrl, toast } from './util.js';

const $ = (id) => document.getElementById(id);
const HINT_KEY = 'burstcam.hint.burst.v1';

export class CameraUI {
  constructor({ camera, library, openGallery }) {
    this.cam = camera;
    this.lib = library;
    this.openGallery = openGallery;
    this.root = $('camera');
    this.shutter = $('shutter');
    this.counter = $('burst-counter');
    this.pendingEl = $('pending');
    this.queued = new Set();
    this.lowSpace = false;
    this.counterTimer = null;

    this.press = createPress({
      holdMs: HOLD_MS,
      onArm: (id) => this._arm(id),
      onBurst: (id) => this._burst(id),
      onRelease: (id, kind) => this._release(id, kind),
    });
    this._bindShutter();
    this._bindPreview();

    $('to-gallery').addEventListener('click', () => this.openGallery());
    $('flip').addEventListener('click', () => this._flip());
    $('torch').addEventListener('click', () => this._torch());
    $('cam-retry').addEventListener('click', () => this.start());
    // Касание строки «8,3 Мп · 30 к/с» — сведения о выбранном пути, долгое — страница замеров.
    let resTimer = null;
    $('res-label').addEventListener('pointerdown', () => { resTimer = setTimeout(() => { resTimer = null; location.href = 'diag.html'; }, 700); });
    $('res-label').addEventListener('pointerup', () => {
      if (!resTimer) return;
      clearTimeout(resTimer);
      const i = this.cam.info();
      toast(`${i.platform} · кадры: ${i.source} · сжатие: ${i.encoders}${i.still ? ` · фото ${i.still.width}×${i.still.height}` : ''}. Удерживайте — замеры`, 4000);
    });

    library.on(() => this._showLatest(false));
    this._showLatest(false);
    this._checkSpace();
    setInterval(() => this._checkSpace(), 15000);

    try { if (!localStorage.getItem(HINT_KEY)) $('hint').hidden = false; } catch { $('hint').hidden = false; }
  }

  async start() {
    $('cam-error').hidden = true;
    this.shutter.disabled = true;
    try {
      if (!window.isSecureContext) throw Object.assign(new Error('insecure'), { name: 'InsecureContext' });
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no gum'), { name: 'NoMediaDevices' });
      await this.cam.start();
      this.shutter.disabled = false;
    } catch (e) {
      this._error(e);
    }
  }

  // ---------- События камеры ----------

  onCameraEvent(evt, data) {
    switch (evt) {
      case 'ready': this._onReady(data); break;
      case 'captured':
        if (data.idx === 0) this._flash();
        if (this.press.bursting || data.idx > 0) this._count(data.idx + 1);
        break;
      case 'burst-start':
        this.root.classList.add('bursting');
        this.shutter.classList.add('burst');
        this._count(1);
        this._hintDone();
        break;
      case 'shot-end':
        this.root.classList.remove('bursting');
        this.shutter.classList.remove('burst');
        clearTimeout(this.counterTimer);
        this.counterTimer = setTimeout(() => { this.counter.hidden = true; }, data.count > 1 ? 900 : 0);
        break;
      case 'limit': toast(`Серия остановлена: максимум ${data.count} кадров`); break;
      case 'queued': this.queued.add(data.id); this._pending(); break;
      case 'still-start': this.shutter.classList.add('down'); break;
      case 'still-end': this.shutter.classList.remove('down'); break;
      case 'camera-ended':
        if (document.visibilityState === 'visible') this.start();
        break;
      case 'frame-error': console.warn('кадр:', data.message); break;
    }
  }

  onSaved(meta) {
    this.queued.delete(meta.id);
    this._pending();
    this.lib.add(meta);
    this._showLatest(true, meta);
  }

  onEncodeError(m) {
    this.queued.delete(m.id);
    this._pending();
    console.error('Ошибка сохранения', m);
    toast('Не удалось сохранить кадр: ' + m.message);
  }

  _onReady(info) {
    const mpx = info.width && info.height ? ((info.width * info.height) / 1e6).toFixed(1).replace('.', ',') : '?';
    let text = `${mpx} Мп · ${info.fps || '—'} к/с`;
    if (info.still) text += ` · фото ${((info.still.width * info.still.height) / 1e6).toFixed(0)} Мп`;
    $('res-label').textContent = text;
    $('res-label').title = `${info.platform} · ${info.source} · ${info.width}×${info.height} · кодировщики: ${info.encoders}`;
    $('preview').classList.toggle('mirror', info.facing === 'user');
    $('torch').hidden = !info.torch;
    this._zoomBar(info.zoom);
  }

  // ---------- Затвор ----------

  _bindShutter() {
    const s = this.shutter;
    s.addEventListener('pointerdown', (e) => {
      if (s.disabled || e.button > 0) return;
      e.preventDefault();
      s.setPointerCapture?.(e.pointerId);
      s.classList.add('down');
      this.press.down();
    });
    const up = () => { s.classList.remove('down'); this.press.up(); };
    s.addEventListener('pointerup', up);
    s.addEventListener('pointercancel', up);
    s.addEventListener('lostpointercapture', () => { if (this.press.pressed) up(); });
    // iOS: без этого долгое касание вызывает лупу/меню, а двойное — масштаб страницы.
    s.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    s.addEventListener('contextmenu', (e) => e.preventDefault());
    // Клавиатура (и пульты/кнопки гарнитур, которые шлют Enter): удержание = серия.
    addEventListener('keydown', (e) => {
      if ((e.code === 'Space' || e.code === 'Enter' || e.key === 'AudioVolumeUp' || e.key === 'AudioVolumeDown') && !e.repeat && this._cameraOnTop()) {
        e.preventDefault();
        if (!s.disabled) { s.classList.add('down'); this.press.down(); }
      }
    });
    addEventListener('keyup', (e) => {
      if (e.code === 'Space' || e.code === 'Enter' || e.key === 'AudioVolumeUp' || e.key === 'AudioVolumeDown') { e.preventDefault(); up(); }
    });
    // Приложение свернули посреди серии — серию останавливаем.
    addEventListener('blur', () => { if (this.press.pressed) up(); });
  }

  _cameraOnTop() {
    return document.getElementById('gallery').hidden && document.getElementById('viewer').hidden && document.getElementById('series')?.hidden !== false;
  }

  _arm(id) {
    if (this.lowSpace) { toast('Мало места на телефоне — удалите лишние фото'); }
    this.cam.arm(id);
    this.cam.platform.haptic('tap');
  }

  _burst(id) {
    if (this.lowSpace) return; // серию не начинаем, одиночный кадр уже взят
    this.cam.burst(id);
  }

  _release(id, kind) {
    this.cam.release(id, kind);
  }

  _count(n) {
    clearTimeout(this.counterTimer);
    this.counter.hidden = false;
    this.counter.textContent = String(n);
  }

  _flash() {
    const f = $('flash');
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
  }

  _pending() {
    const n = this.queued.size;
    this.pendingEl.hidden = n === 0;
    this.pendingEl.textContent = String(n);
  }

  _showLatest(pop, meta = this.lib.latest) {
    const img = $('last-thumb');
    if (!meta) { img.hidden = true; return; }
    const url = thumbUrl(meta);
    if (img.src !== url) img.src = url;
    img.hidden = false;
    if (pop) {
      const b = $('to-gallery');
      b.classList.remove('pop');
      void b.offsetWidth;
      b.classList.add('pop');
    }
  }

  _hintDone() {
    const h = $('hint');
    if (h.hidden) return;
    h.classList.add('fade');
    setTimeout(() => { h.hidden = true; }, 500);
    try { localStorage.setItem(HINT_KEY, '1'); } catch { /* нет хранилища */ }
  }

  async _checkSpace() {
    try {
      const { quota, usage } = await navigator.storage.estimate();
      this.lowSpace = quota - usage < MIN_FREE_BYTES;
    } catch { this.lowSpace = false; }
  }

  // ---------- Управление ----------

  async _flip() {
    const btn = $('flip');
    btn.disabled = true;
    this.shutter.disabled = true;
    $('preview').style.opacity = '0.2';
    try {
      await this.cam.switchFacing();
      this.shutter.disabled = false;
    } catch (e) { this._error(e); }
    finally { btn.disabled = false; $('preview').style.opacity = ''; }
  }

  async _torch() {
    const b = $('torch');
    const on = b.getAttribute('aria-pressed') !== 'true';
    try { if (await this.cam.setTorch(on)) b.setAttribute('aria-pressed', String(on)); } catch { toast('Фонарик недоступен'); }
  }

  _zoomBar(zoom) {
    const bar = $('zoom-bar');
    if (!zoom || !(zoom.max > zoom.min)) { bar.hidden = true; return; }
    const presets = [zoom.min < 1 ? zoom.min : null, 1, 2, 5].filter((z) => z != null && z >= zoom.min && z <= zoom.max);
    const uniq = [...new Set(presets.map((z) => Math.round(z * 10) / 10))];
    if (uniq.length < 2) { bar.hidden = true; return; }
    bar.replaceChildren(...uniq.map((z) => {
      const b = document.createElement('button');
      b.dataset.z = z;
      b.textContent = `${String(z).replace('.', ',')}×`;
      b.onclick = () => this._setZoom(z);
      return b;
    }));
    bar.hidden = false;
    this._markZoom(this.cam.zoom);
  }

  _setZoom(z) {
    this.cam.setZoom(z);
    this._markZoom(z);
  }

  _markZoom(z) {
    const bar = $('zoom-bar');
    let best = null;
    for (const b of bar.children) {
      if (best == null || Math.abs(Number(b.dataset.z) - z) < Math.abs(Number(best.dataset.z) - z)) best = b;
    }
    for (const b of bar.children) {
      const on = b === best;
      b.classList.toggle('on', on);
      b.textContent = on && Math.abs(Number(b.dataset.z) - z) > 0.05 ? `${z.toFixed(1).replace('.', ',')}×` : `${String(b.dataset.z).replace('.', ',')}×`;
    }
  }

  _bindPreview() {
    const wrap = $('preview-wrap');
    const pts = new Map();
    let pinch = null;
    let tap = null;
    wrap.addEventListener('pointerdown', (e) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), z0: this.cam.zoom };
        tap = null;
      } else tap = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 12) tap = null;
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const z = pinch.z0 * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0);
        const r = this.cam.caps.zoom;
        if (r) { const zz = Math.min(r.max, Math.max(r.min, z)); this.cam.setZoom(zz); this._markZoom(zz); }
      }
    });
    const end = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (tap && e.type === 'pointerup' && performance.now() - tap.t < 400) this._focus(tap.x, tap.y);
      tap = null;
    };
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);
  }

  async _focus(x, y) {
    if (!this.cam.focusSupported()) return;
    const v = $('preview');
    const r = v.getBoundingClientRect();
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    // object-fit: cover — пересчитываем точку экрана в координаты кадра.
    const k = Math.max(r.width / vw, r.height / vh);
    const ox = (r.width - vw * k) / 2, oy = (r.height - vh * k) / 2;
    let nx = (x - r.left - ox) / (vw * k);
    const ny = (y - r.top - oy) / (vh * k);
    if (v.classList.contains('mirror')) nx = 1 - nx;
    const ring = $('focus-ring');
    ring.hidden = true;
    void ring.offsetWidth;
    ring.style.left = `${x - r.left}px`;
    ring.style.top = `${y - r.top}px`;
    ring.hidden = false;
    await this.cam.focusAt(Math.min(1, Math.max(0, nx)), Math.min(1, Math.max(0, ny)));
  }

  _error(e) {
    console.error(e);
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const map = {
      InsecureContext: 'Камера работает только по защищённому адресу (https://…). Откройте адрес, который показывает сервер на ноутбуке, и установите сертификат по инструкции.',
      NoMediaDevices: 'Этот браузер не даёт доступа к камере. Откройте приложение в Safari (iPhone) или Chrome (Android).',
      NotAllowedError: ios
        ? 'Нет доступа к камере. Настройки → Safari → Камера → «Разрешить» (или «Спросить»), затем «Повторить».'
        : 'Нет доступа к камере. Нажмите на значок слева от адреса → Разрешения → Камера → Разрешить, затем «Повторить».',
      NotFoundError: 'Камера не найдена.',
      NotReadableError: 'Камера занята другим приложением. Закройте его и нажмите «Повторить».',
      OverconstrainedError: 'Камера не поддерживает нужный режим.',
      AbortError: 'Камера не запустилась. Нажмите «Повторить».',
    };
    $('cam-error-text').textContent = map[e.name] || `Камера не запустилась: ${e.message || e.name}`;
    $('cam-error').hidden = false;
    $('cam-status').textContent = '';
  }
}

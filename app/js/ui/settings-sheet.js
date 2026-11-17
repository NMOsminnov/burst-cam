// Лист «Настройки съёмки»: объектив, что снимает касание, режим потока, качество JPEG.
import { QUALITY } from '../core/settings.js';
import { nav, toast } from './util.js';

const mpStr = (w, h) => ((w * h) / 1e6).toFixed(1).replace('.', ',').replace(/,0$/, '') + ' Мп';

export class SettingsSheet {
  constructor({ el, camera }) {
    this.el = el;
    this.cam = camera;
    this.body = el.querySelector('[data-ref="body"]');
    el.addEventListener('click', (e) => this._onClick(e));
  }

  show() {
    this.el.hidden = false;
    this.render();
    nav.open(this);
  }

  hide() { this.el.hidden = true; }

  render(modes = this.cam.modes) {
    const i = this.cam.info();
    const p = this.cam.prefs;
    const parts = [];

    // Объектив.
    if (i.lenses.length) {
      const cur = this.cam.settings.deviceId;
      parts.push(`<section><h3>Объектив</h3><div class="chips">${i.lenses
        .map((l) => `<button class="chip ${l.deviceId === cur ? 'on' : ''}" data-act="lens" data-id="${esc(l.deviceId)}">${esc(l.name)}</button>`)
        .join('')}</div>${i.lenses.filter((l) => l.facing === 'environment').length <= 1
        ? '<p class="note">Браузер показывает одну заднюю камеру. Если у телефона есть ультраширик, он может включаться зумом «0,5×» на экране камеры.</p>'
        : i.lenses.some((l) => l.kind === 'ultra') ? '' : '<p class="note">Браузер не подписывает объективы — какая камера ультраширокая, видно по превью.</p>'}</section>`);
    }

    // Что снимает касание.
    const sw = i.width, sh = i.height;
    const streamLine = sw ? `${Math.max(sw, sh)}×${Math.min(sw, sh)} · ${mpStr(sw, sh)}` : '';
    const opts = [];
    const stillModes = i.still?.modes || this._stillModesCache || [];
    if (i.still?.modes) this._stillModesCache = i.still.modes;
    for (const m of stillModes) {
      const on = p.tapMode === 'native' && p.stillSize === m.id;
      opts.push(radio('tap', `native:${m.id}`, on,
        `Родное фото камеры · ${mpStr(m.width, m.height)}`,
        `${m.width}×${m.height}${m.id === 'half' ? ', с объединением пикселей — чище в темноте' : ', полное разрешение сенсора'}. 0,3–1,5 с на снимок.`));
    }
    opts.push(radio('tap', 'stream', p.tapMode === 'stream' || !stillModes.length,
      `Кадр видеопотока · ${streamLine || '—'}`, 'Мгновенно, ровно в момент касания.'));
    const noNative = typeof ImageCapture === 'undefined'
      ? '<p class="note">Этот браузер не даёт сайтам родной снимок камеры (так у Safari на iPhone) — фото берётся из видеопотока; выберите ниже режим с наибольшим разрешением.</p>'
      : (!stillModes.length && p.tapMode === 'native' ? '<p class="note">Определяю родные режимы камеры…</p>' : '');
    parts.push(`<section><h3>Касание кнопки снимает</h3>${opts.join('')}${noNative}</section>`);

    // Режим потока.
    const sel = i.streamMode;
    let modesHtml;
    if (!modes) {
      modesHtml = `<button class="wide-btn" data-act="probe">Определить режимы камеры</button><p class="note">Сейчас: ${streamLine || '—'} · ${i.fps} к/с. Превью на пару секунд мигнёт.</p>`;
    } else {
      modesHtml = radio('mode', 'auto', !sel, 'Автоматически', 'Наибольшее разрешение, при котором поток держит ~20 к/с.')
        + modes.map((m) => radio('mode', `${m.width}x${m.height}`, !!sel && sel[0] === m.width && sel[1] === m.height,
          `${m.width}×${m.height} · ${String(m.mp).replace('.', ',')} Мп`, m.fps ? `до ${m.fps} к/с` : '')).join('');
    }
    parts.push(`<section><h3>Режим камеры</h3><p class="note">Разрешение превью, серии удержанием${stillModes.length && p.tapMode === 'native' ? '' : ' и фото по касанию'}.</p>${modesHtml}</section>`);

    // Качество.
    parts.push(`<section><h3>Качество JPEG</h3>${Object.entries(QUALITY)
      .map(([k, v]) => radio('quality', k, p.quality === k, v.label, v.hint)).join('')}${
      p.tapMode === 'native' && stillModes.length ? '<p class="note">Родной снимок сохраняется как есть, без пересжатия — эта настройка касается кадров потока.</p>' : ''}</section>`);

    this.body.innerHTML = parts.join('');
  }

  async _onClick(e) {
    if (e.target === this.el) { nav.back(); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    try {
      if (act === 'close') nav.back();
      else if (act === 'lens') { await this._busy(() => this.cam.selectLens(b.dataset.id)); }
      else if (act === 'probe') {
        b.disabled = true;
        b.textContent = 'Опрашиваю камеру…';
        const modes = await this.cam.listModes();
        this.render(modes);
      } else if (act === 'pick') {
        const [group, value] = [b.dataset.group, b.dataset.value];
        if (group === 'tap') {
          if (value === 'stream') await this.cam.setTapMode('stream');
          else await this.cam.setTapMode('native', value.split(':')[1]);
        } else if (group === 'mode') {
          await this._busy(() => this.cam.setStreamMode(value === 'auto' ? null : value.split('x').map(Number)));
        } else if (group === 'quality') this.cam.setQuality(value);
        this.render();
      }
    } catch (err) {
      toast('Не получилось: ' + err.message);
      this.render();
    }
  }

  async _busy(fn) {
    this.body.classList.add('wait');
    try { await fn(); } finally { this.body.classList.remove('wait'); this.render(); }
  }
}

function radio(group, value, on, title, hint) {
  return `<button class="opt ${on ? 'on' : ''}" data-act="pick" data-group="${group}" data-value="${esc(value)}" role="radio" aria-checked="${on}">
    <span class="dot"></span><span class="txt"><b>${esc(title)}</b>${hint ? `<small>${esc(hint)}</small>` : ''}</span></button>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

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
    const stillModes = i.stillModes || [];
    const autoWhat = i.still ? `сейчас — родное фото ${mpStr(i.still.width, i.still.height)}` : (stillModes.length ? 'сейчас — мгновенный кадр (родное фото не крупнее)' : 'сейчас — мгновенный кадр');
    opts.push(radio('tap', 'auto', p.tapMode === 'auto', 'Авто', `Родное фото, если оно заметно крупнее кадра потока; иначе кадр в момент касания — без задержки и смаза. ${autoWhat}.`));
    for (const m of stillModes) {
      const on = p.tapMode === 'native' && p.stillSize === m.id;
      opts.push(radio('tap', `native:${m.id}`, on,
        `Всегда родное фото · ${mpStr(m.width, m.height)}`,
        `${m.width}×${m.height}${m.id === 'half' ? ', с объединением пикселей — чище в темноте' : ''}. Снимается 0,4–1,5 с после касания — держите телефон неподвижно, пока кнопка жёлтая.`));
    }
    opts.push(radio('tap', 'stream', p.tapMode === 'stream',
      `Всегда кадр видеопотока · ${streamLine || '—'}`, 'Мгновенно, ровно в момент касания.'));
    const noNative = typeof ImageCapture === 'undefined'
      ? '<p class="note">Этот браузер не даёт сайтам родной снимок камеры (так у Safari на iPhone) — фото берётся из видеопотока; выберите ниже режим с наибольшим разрешением.</p>'
      : (!stillModes.length && p.tapMode !== 'stream'
        ? `<p class="note">${i.stillReason === 'проверяю…' ? 'Определяю родные режимы камеры…' : 'Родной снимок недоступен: ' + esc(i.stillReason || 'причина неизвестна') + '. Фото берётся из видеопотока.'}</p>`
        : '');
    const cap = stillModes.length ? '<p class="note">Это наибольшее, что камера отдаёт браузеру. Полное разрешение 50–200 Мп производители обычно оставляют только своему приложению «Камера» — сторонним (и браузеру) чаще всего дают 12 Мп.</p>' : '';
    parts.push(`<section><h3>Касание кнопки снимает</h3>${opts.join('')}${noNative}${cap}</section>`);

    // Режим потока.
    const sel = i.streamMode;
    let modesHtml;
    if (!modes || !modes.length) {
      modesHtml = `<p class="note">Определяю режимы камеры… Сейчас: ${streamLine || '—'} · ${i.fps} к/с.</p>`;
    } else {
      const mpS = (a) => ((a[0] * a[1]) / 1e6).toFixed(1).replace('.', ',').replace(/,0$/, '');
      modesHtml = radio('mode', 'auto', !sel, 'Автоматически', 'Режим, при котором родное фото крупнее всего; без родного фото — наибольший поток с ~20 к/с.')
        + modes.map((m) => radio('mode', `${m.width}x${m.height}`, !!sel && sel[0] === m.width && sel[1] === m.height,
          `${m.width}×${m.height} · ${String(m.mp).replace('.', ',')} Мп`,
          [m.fps ? `до ${m.fps} к/с` : '', m.photo ? `родное фото ${mpS(m.photo)} Мп` : ''].filter(Boolean).join(' · '))).join('');
    }
    parts.push(`<section><h3>Режим камеры</h3><p class="note">Разрешение превью, серии удержанием${i.still ? '' : ' и фото по касанию'}.</p>${modesHtml}</section>`);

    // Защита от смаза.
    const ab = i.antiblur || {};
    const abNote = !ab.supported ? 'Эта камера не даёт браузеру управлять выдержкой — защита недоступна.'
      : ab.state === 'manual' ? `Сейчас работает: выдержка 1/${Math.round(1e4 / ab.exposureTime)} с, ISO ${Math.round(ab.iso)}.`
      : ab.state === 'off' ? 'На этом телефоне не сработала (ISO не меняет яркость) — снимает автоматика камеры.'
      : 'Сейчас светло — автоматика камеры и так снимает быстро.';
    parts.push(`<section><h3>Защита от смаза</h3>${radio('antiblur', 'on', ab.on, 'Включена', 'Выдержка не длиннее 1/30 с (при зуме от 2× — 1/60 с), недостающий свет — за счёт ISO. В темноте фото чётче, но шумнее; частота кадров ровнее.')}${radio('antiblur', 'off', !ab.on, 'Выключена', 'Выдержку выбирает камера: в помещении до 1/25 с и дольше.')}<p class="note">${abNote}</p></section>`);

    // Качество.
    parts.push(`<section><h3>Качество JPEG</h3>${Object.entries(QUALITY)
      .map(([k, v]) => radio('quality', k, p.quality === k, v.label, v.hint)).join('')}${
      i.still ? '<p class="note">Родной снимок сохраняется как есть, без пересжатия — эта настройка касается кадров потока.</p>' : ''}</section>`);

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
 else if (act === 'pick') {
        const [group, value] = [b.dataset.group, b.dataset.value];
        if (group === 'tap') {
          if (value === 'stream' || value === 'auto') await this.cam.setTapMode(value);
          else await this.cam.setTapMode('native', value.split(':')[1]);
        } else if (group === 'mode') {
          await this._busy(() => this.cam.setStreamMode(value === 'auto' ? null : value.split('x').map(Number)));
        } else if (group === 'quality') this.cam.setQuality(value);
        else if (group === 'antiblur') await this.cam.setAntiblur(value === 'on');
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

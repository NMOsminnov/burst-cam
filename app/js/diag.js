// Диагностика на телефоне: поддержка API в окне и в воркере, режим камеры, скорость сжатия.
import { pickPlatform } from './platform/index.js';
import { openStream, probeModes } from './platform/stream.js';
import { describeLenses } from './platform/lenses.js';
import { setupStill } from './platform/still.js';
import { canvasKit } from './core/encode.js';
import { JPEG_QUALITY } from './core/config.js';

const report = {};
const $ = (id) => document.getElementById(id);
const yes = (v) => `<span class="${v ? 'y' : 'n'}">${v ? 'да' : 'нет'}</span>`;

function row(table, k, v) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${k}</td><td>${v}</td>`;
  $(table).appendChild(tr);
}

function dump() { $('dump').textContent = JSON.stringify(report, null, 1); }

async function workerCaps() {
  const src = `
    const out = { mstp: typeof MediaStreamTrackProcessor !== 'undefined', videoFrame: typeof VideoFrame !== 'undefined',
      offscreen: typeof OffscreenCanvas !== 'undefined', idb: typeof indexedDB !== 'undefined', jpeg: false };
    (async () => {
      try { const c = new OffscreenCanvas(8, 8); c.getContext('2d').fillRect(0,0,8,8);
        const b = await c.convertToBlob({ type: 'image/jpeg', quality: .9 }); out.jpeg = b.type === 'image/jpeg'; } catch (e) {}
      postMessage(out);
    })();`;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  return new Promise((r) => { w.onmessage = (e) => { r(e.data); w.terminate(); }; setTimeout(() => r({ timeout: true }), 3000); });
}

async function caps() {
  const p = pickPlatform();
  const wc = await workerCaps();
  const c = {
    module: p.label,
    secureContext: window.isSecureContext,
    getUserMedia: !!navigator.mediaDevices?.getUserMedia,
    ImageCapture: typeof ImageCapture !== 'undefined',
    'MediaStreamTrackProcessor (окно)': typeof window.MediaStreamTrackProcessor === 'function',
    'MediaStreamTrackProcessor (воркер)': !!wc.mstp,
    'OffscreenCanvas → JPEG (воркер)': !!wc.jpeg,
    requestVideoFrameCallback: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    'Web Share (файлы)': !!navigator.canShare,
    'Установлено как приложение': matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone === true,
    ядер: navigator.hardwareConcurrency,
    'память, ГБ (только Chromium)': navigator.deviceMemory ?? '—',
  };
  try {
    const est = await navigator.storage.estimate();
    c['хранилище: занято / квота'] = `${(est.usage / 1048576).toFixed(0)} МБ / ${(est.quota / 1073741824).toFixed(1)} ГБ`;
    c['хранилище не вычищается'] = await navigator.storage.persisted?.();
  } catch { /* нет */ }
  for (const [k, v] of Object.entries(c)) row('caps', k, typeof v === 'boolean' ? yes(v) : v);
  report.ua = navigator.userAgent;
  report.screen = `${screen.width}x${screen.height}@${devicePixelRatio}`;
  report.caps = c;
  dump();
}

async function bench() {
  $('run').disabled = true;
  $('cam').innerHTML = '';
  const cam = {};
  report.camera = cam;
  try {
    const t0 = performance.now();
    const { stream, track, caps: tc } = await openStream({ facing: 'environment', status: (s) => row('cam', 'статус', s) });
    cam.openMs = Math.round(performance.now() - t0);
    const v = $('v');
    v.srcObject = stream;
    await v.play();
    const s = track.getSettings();
    cam.settings = `${s.width}x${s.height} @ ${s.frameRate ?? '?'} к/с`;
    cam.capabilities = tc?.width ? `до ${tc.width.max}x${tc.height.max}, zoom ${tc.zoom ? tc.zoom.min + '–' + tc.zoom.max : 'нет'}, torch ${!!tc.torch}` : 'getCapabilities нет';
    row('cam', 'открытие + подбор', cam.openMs + ' мс');
    row('cam', 'поток', cam.settings);
    row('cam', 'возможности', cam.capabilities);

    // Реальная частота кадров.
    if ('requestVideoFrameCallback' in v) {
      let n = 0; const start = performance.now();
      await new Promise((r) => { const cb = () => { n++; if (performance.now() - start < 1500) v.requestVideoFrameCallback(cb); else r(); }; v.requestVideoFrameCallback(cb); });
      cam.realFps = Math.round((n * 1000) / (performance.now() - start));
      row('cam', 'реальная частота', cam.realFps + ' к/с');
    }

    // Захват кадра: createImageBitmap(video).
    const bmps = [];
    let tGrab = 0;
    for (let i = 0; i < 8; i++) {
      const a = performance.now();
      bmps.push(await createImageBitmap(v));
      tGrab += performance.now() - a;
      await new Promise((r) => setTimeout(r, 40));
    }
    cam.grabMs = +(tGrab / 8).toFixed(1);
    row('cam', 'копия кадра (createImageBitmap)', cam.grabMs + ' мс');

    // Сжатие в главном потоке.
    const kit = canvasKit();
    let tMain = 0;
    for (const b of bmps.slice(0, 3)) {
      const c = kit.get('full', b.width, b.height);
      c.getContext('2d').drawImage(b, 0, 0);
      const a = performance.now();
      await kit.toBlob(c, 'image/jpeg', JPEG_QUALITY);
      tMain += performance.now() - a;
    }
    cam.jpegMainMs = Math.round(tMain / 3);
    row('cam', 'JPEG, главный поток', cam.jpegMainMs + ' мс/кадр');

    // Сжатие пулом воркеров (как в приложении).
    const p = pickPlatform();
    const nWorkers = p.encoders();
    const src = `onmessage = async (e) => { const b = e.data; const c = new OffscreenCanvas(b.width, b.height);
      c.getContext('2d').drawImage(b, 0, 0); const a = performance.now();
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: ${JPEG_QUALITY} });
      postMessage({ ms: performance.now() - a, size: blob.size, type: blob.type }); b.close(); };`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const ws = Array.from({ length: nWorkers }, () => new Worker(url));
    const rest = bmps.slice(3);
    const a = performance.now();
    const results = await Promise.all(rest.map((b, i) => new Promise((r) => {
      const w = ws[i % ws.length];
      const h = (e) => { w.removeEventListener('message', h); r(e.data); };
      w.addEventListener('message', h);
      w.postMessage(b, [b]);
    }))).catch(() => []);
    const wall = performance.now() - a;
    ws.forEach((w) => w.terminate());
    if (results.length) {
      cam.jpegWorkerMs = Math.round(results.reduce((s, x) => s + x.ms, 0) / results.length);
      cam.workerThroughputFps = +((results.length * 1000) / wall).toFixed(1);
      cam.jpegSizeMB = +(results[0].size / 1048576).toFixed(2);
      row('cam', `JPEG, ${nWorkers} воркера`, `${cam.jpegWorkerMs} мс/кадр, ${cam.workerThroughputFps} кадр/с суммарно`);
      row('cam', 'размер кадра JPEG', cam.jpegSizeMB + ' МБ');
    }

    // Полноразмерный снимок.
    const still = await setupStill(track);
    if (still) {
      const b = performance.now();
      const blob = await still.take();
      cam.takePhoto = blob ? `${still.width}x${still.height}, ${Math.round(performance.now() - b)} мс, ${(blob.size / 1048576).toFixed(1)} МБ` : 'не удалось';
    } else cam.takePhoto = typeof ImageCapture !== 'undefined' ? 'нет выигрыша в разрешении' : 'API нет';
    row('cam', 'takePhoto (одиночное фото)', cam.takePhoto);

    stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    cam.error = `${e.name}: ${e.message}`;
    row('cam', 'ошибка', cam.error);
  }
  dump();
  $('run').disabled = false;
}

async function lenses() {
  $('lenses').disabled = true;
  $('lens-table').innerHTML = '';
  const list = [];
  report.lenses = list;
  try {
    // Ярлыки камер браузер отдаёт только после разрешения — сначала открываем любую.
    const warm = await navigator.mediaDevices.getUserMedia({ video: true });
    warm.getTracks().forEach((t) => t.stop());
    const { lenses: ls } = describeLenses(await navigator.mediaDevices.enumerateDevices());
    for (const l of ls) {
      const item = { name: l.name, label: l.label, kind: l.kind };
      list.push(item);
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: l.deviceId } } });
        const t = s.getVideoTracks()[0];
        const caps = t.getCapabilities ? t.getCapabilities() : {};
        item.max = caps.width ? `${caps.width.max}×${caps.height.max}` : '—';
        item.zoom = caps.zoom ? `${caps.zoom.min}–${caps.zoom.max}` : '—';
        item.focus = (caps.focusMode || []).join(', ') || '—';
        item.torch = !!caps.torch;
        const modes = await probeModes(t, caps);
        item.modes = modes.map((m) => `${m.width}×${m.height}${m.fps ? '@' + m.fps : ''}`).join(', ');
        if (typeof ImageCapture !== 'undefined') {
          try {
            const pc = await new ImageCapture(t).getPhotoCapabilities();
            item.photo = `${pc.imageWidth.max}×${pc.imageHeight.max} (${((pc.imageWidth.max * pc.imageHeight.max) / 1e6).toFixed(1)} Мп)`;
          } catch (e) { item.photo = 'ошибка: ' + e.name + ' ' + e.message; }
        } else item.photo = 'нет API';
        s.getTracks().forEach((x) => x.stop());
      } catch (e) {
        item.error = `${e.name}: ${e.message}`;
      }
      row('lens-table', `<b>${item.name}</b><br><small>${item.label}</small>`,
        item.error || `наибольший поток ${item.max}<br>режимы: ${item.modes}<br>родное фото: ${item.photo}<br>зум ${item.zoom}, фокус: ${item.focus}${item.torch ? ', фонарик' : ''}`);
      dump();
    }
  } catch (e) {
    row('lens-table', 'ошибка', `${e.name}: ${e.message}`);
  }
  dump();
  $('lenses').disabled = false;
}

$('lenses').onclick = lenses;
$('run').onclick = bench;
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('dump').textContent); $('copy').textContent = 'Скопировано'; }
  catch { getSelection().selectAllChildren($('dump')); }
};
caps();

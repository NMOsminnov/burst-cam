// Точка входа: собирает платформенный модуль, кодировщики, камеру и экраны.
import { pickPlatform } from './platform/index.js';
import { EncoderPool } from './core/encoders.js';
import { Camera } from './core/camera.js';
import { Library } from './ui/library.js';
import { CameraUI } from './ui/camera-ui.js';
import { GalleryView } from './ui/gallery.js';
import { Viewer } from './ui/viewer.js';
import { nav, toast } from './ui/util.js';
import { SettingsSheet } from './ui/settings-sheet.js';
import { loadSettings } from './core/settings.js';
import { initTelemetry, track, log, highEntropy } from './core/telemetry.js';

const params = new URLSearchParams(location.search);

async function boot() {
  initTelemetry({ pageName: 'app' });
  highEntropy().then((v) => v && track('device-model', v));
  if (params.has('fake')) {
    // Поддельная камера для проверки без телефона (тесты, компьютер без камеры).
    const { installFakeCamera } = await import('./test/fake-camera.js');
    installFakeCamera(params.get('fake'));
  }

  nav.init();
  const platform = pickPlatform();
  document.documentElement.dataset.platform = platform.id;

  const library = new Library();
  let ui = null;
  const pool = new EncoderPool({
    count: platform.encoders(),
    onSaved: (meta) => {
      track('saved', { id: meta.id, idx: meta.idx, w: meta.width, h: meta.height, bytes: meta.bytes, source: meta.source, encodeMs: meta.encodeMs });
      ui?.onSaved(meta);
    },
    onError: (m) => { log('error', 'encode', m); ui?.onEncodeError(m); },
  });

  const status = (msg) => { document.getElementById('cam-status').textContent = msg; };
  let sheet = null;
  const camera = new Camera({
    video: document.getElementById('preview'),
    platform,
    pool,
    settings: loadSettings(),
    onEvent: (evt, data) => {
      ui?.onCameraEvent(evt, data);
      // В журнал — всё, кроме частых событий каждого кадра.
      if (evt !== 'captured' && evt !== 'queued') track('camera:' + evt, evt === 'ready' ? { ...data, settings: camera.settings, caps: camera.caps } : data);
      if (evt === 'ready' && sheet && !sheet.el.hidden) sheet.render();
    },
    status,
  });
  sheet = new SettingsSheet({ el: document.getElementById('settings-sheet'), camera });

  // Галерея, серия, просмотр.
  const galleryEl = document.getElementById('gallery');
  const seriesEl = galleryEl.cloneNode(true);
  seriesEl.id = 'series';
  seriesEl.setAttribute('aria-label', 'Серия');
  galleryEl.after(seriesEl);

  let viewer, gallery, series;
  const openViewer = (list, index, context) => viewer.open(list, index, context);
  const openSeries = (seriesId) => series.show(seriesId);
  viewer = new Viewer({ el: document.getElementById('viewer'), library, openSeries });
  gallery = new GalleryView({ el: galleryEl, mode: 'root', library, openViewer, openSeries });
  series = new GalleryView({ el: seriesEl, mode: 'series', library, openViewer, openSeries });

  ui = new CameraUI({ camera, library, openGallery: () => gallery.show(), openSettings: () => sheet.show() });
  // Для диагностики (diag.html, консоль) и тестов.
  window.burstcam = { camera, pool, library, platform, info: () => camera.info() };

  // Параллельно: кодировщики, библиотека, камера.
  status('Включаю камеру…');
  await Promise.all([
    pool.init(),
    library.load().catch((e) => { console.error(e); toast('Галерея не открылась: ' + e.message); }),
  ]);
  await ui.start();

  // Камеру отдаём системе, когда приложение свёрнуто, и забираем обратно при возврате.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') camera.stop();
    else ui.start();
  });
  addEventListener('pageshow', (e) => { if (e.persisted) ui.start(); });

  // Попросить браузер не удалять фото при нехватке места.
  navigator.storage?.persist?.().catch(() => {});

  registerSW(() => pool && ui && ui.queued.size === 0 && !ui.press.pressed);
}

function registerSW(isIdle) {
  if (!('serviceWorker' in navigator) || params.has('nosw')) return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW:', e.message));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    // Новая версия приложения: перезагружаемся, когда ничего не снимается и не сохраняется.
    const tryReload = () => {
      if (isIdle()) { reloading = true; location.reload(); } else setTimeout(tryReload, 1000);
    };
    if (navigator.serviceWorker.controller && sessionStorage.getItem('burstcam.sw') === '1') tryReload();
    sessionStorage.setItem('burstcam.sw', '1');
  });
  if (navigator.serviceWorker.controller) sessionStorage.setItem('burstcam.sw', '1');
}

boot().catch((e) => {
  log('error', 'boot', { message: e.message, stack: e.stack });
  console.error(e);
  document.getElementById('cam-error-text').textContent = 'Не удалось запустить приложение: ' + e.message;
  document.getElementById('cam-error').hidden = false;
});

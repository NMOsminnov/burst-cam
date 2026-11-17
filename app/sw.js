// Service worker: приложение открывается мгновенно и без сети.
// VERSION и FILES подставляет сервер (хэш и список файлов app/), так что любая правка
// кода = новая версия, старый кэш удаляется.
const VERSION = '__VERSION__';
const FILES = "__FILES__";
const CACHE = `burstcam-${VERSION}`;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(['./', ...(Array.isArray(FILES) ? FILES : [])]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('burstcam-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.search.includes('fake') || url.pathname.includes('/test/')) return; // тестовый режим — мимо кэша

  if (req.mode === 'navigate') {
    // Страница: сначала сеть (свежая версия), без сети — из кэша.
    e.respondWith(
      fetch(req).catch(() => caches.match('./', { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))),
    );
    return;
  }
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)),
  );
});

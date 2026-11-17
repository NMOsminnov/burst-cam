// Журнал для разбора проблем: события, ошибки и сведения о камере уходят на сервер ноутбука
// (POST /api/log того же адреса, с которого открыто приложение). Никуда больше. Фото не уходят.
// Если сервера журнала нет (приложение открыто с другого хостинга) — после пары неудач молчит.

const MAX_QUEUE = 400;
const FLUSH_MS = 2000;

const session = Math.random().toString(36).slice(2, 10);
const queue = [];
let failures = 0;
let timer = null;
let page = 'app';

export function initTelemetry({ pageName = 'app' } = {}) {
  page = pageName;
  hookConsole();
  addEventListener('error', (e) => log('error', 'window.error', { message: e.message, src: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack }));
  addEventListener('unhandledrejection', (e) => log('error', 'unhandledrejection', { message: String(e.reason?.message || e.reason), stack: e.reason?.stack }));
  document.addEventListener('visibilitychange', () => {
    log('info', 'visibility', { state: document.visibilityState });
    if (document.visibilityState === 'hidden') flush(true);
  });
  log('info', 'start', device());
}

/** Записать событие. level: info | warn | error. */
export function log(level, kind, data) {
  queue.push({ t: Date.now(), level, kind, data: safe(data) });
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  if (!timer && failures < 3) timer = setTimeout(() => flush(false), level === 'error' ? 200 : FLUSH_MS);
}

export const track = (kind, data) => log('info', kind, data);

export function flush(beacon) {
  clearTimeout(timer);
  timer = null;
  if (!queue.length || failures >= 3) return;
  const entries = queue.splice(0, queue.length);
  const body = JSON.stringify({ session, page, entries });
  const url = new URL('api/log', location.href).href;
  if (beacon && navigator.sendBeacon) {
    if (navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
  }
  fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: body.length < 60000 })
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); failures = 0; })
    .catch(() => {
      failures++;
      if (failures < 3) { queue.unshift(...entries.slice(-100)); timer = setTimeout(() => flush(false), 5000); }
    });
}

function device() {
  return {
    ua: navigator.userAgent,
    uaData: navigator.userAgentData ? { mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform, brands: navigator.userAgentData.brands } : null,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    memory: navigator.deviceMemory, cores: navigator.hardwareConcurrency,
    standalone: matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches,
    url: location.pathname + location.search,
  };
}

function hookConsole() {
  for (const level of ['warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      try { log(level, 'console', { msg: args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : JSON.stringify(safe(a)))).join(' ') }); } catch { /* не мешать */ }
    };
  }
}

function safe(v, depth = 0) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > 4000 ? v.slice(0, 4000) + '…' : v;
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
  if (typeof Blob !== 'undefined' && v instanceof Blob) return { blob: v.type, size: v.size };
  if (depth > 5) return '…';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => safe(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).slice(0, 60)) o[k] = safe(v[k], depth + 1);
    return o;
  }
  return String(v);
}

/** Получить расширенные сведения о браузере (модель телефона — если Chrome её отдаст). */
export async function highEntropy() {
  try {
    return await navigator.userAgentData?.getHighEntropyValues(['model', 'platformVersion', 'fullVersionList']);
  } catch { return null; }
}

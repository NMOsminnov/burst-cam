// Локальный сервер BurstCam: HTTPS для приложения и HTTP-страница «как подключить телефон».
//
//   node server/serve.js [--port 8443] [--http 8080] [--quiet]
//
// HTTPS-сертификат перевыпускается при запуске и при появлении нового адреса
// (например, вы включили точку доступа уже после запуска) — перезапускать не нужно.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadOrCreateCA, issueServerCert, caDer, fingerprint } from './certs.js';
import { listAddresses } from './net.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const HTTPS_PORT = Number(arg('port', process.env.BURSTCAM_PORT || 8443));
const HTTP_PORT = Number(arg('http', process.env.BURSTCAM_HTTP_PORT || 8080));
const QUIET = args.includes('--quiet');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const log = (...a) => { if (!QUIET) console.log(...a); };

// ---------- Версия приложения (для обновления service worker) ----------

function appVersion() {
  const h = crypto.createHash('sha1');
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { h.update(path.relative(APP, p)); h.update(fs.readFileSync(p)); }
    }
  };
  walk(APP);
  return h.digest('hex').slice(0, 12);
}

function listAppFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push('./' + path.relative(APP, p).split(path.sep).join('/'));
    }
  };
  walk(APP);
  return out.filter((f) => f !== './sw.js' && !f.startsWith('./test/')).sort();
}

// ---------- Раздача файлов приложения ----------

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function serveApp(req, res) {
  const url = new URL(req.url, 'https://x');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(APP, rel));
  if (!file.startsWith(APP + path.sep)) return send(res, 403, 'forbidden');
  if (rel === '/ca.crt') return serveCA(res);

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
    const headers = {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      // Кэшем управляет service worker; браузер всегда сверяется с сервером.
      'Cache-Control': 'no-cache',
      'Permissions-Policy': 'camera=(self)',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (rel === '/sw.js') {
      const body = fs
        .readFileSync(file, 'utf8')
        .replace('__VERSION__', appVersion())
        .replace('"__FILES__"', JSON.stringify(listAppFiles()));
      return send(res, 200, body, { ...headers, 'Service-Worker-Allowed': '/' });
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

function serveCA(res) {
  const der = caDer(ROOT);
  res.writeHead(200, {
    'Content-Type': 'application/x-x509-ca-cert',
    'Content-Disposition': 'attachment; filename="BurstCam-CA.crt"',
    'Content-Length': der.length,
    'Cache-Control': 'no-store',
  });
  res.end(der);
}

// ---------- HTTP: страница подключения телефона ----------

function landing(req) {
  const host = (req.headers.host || 'localhost').split(':')[0];
  const httpsUrl = `https://${host}:${HTTPS_PORT}/`;
  const ua = req.headers['user-agent'] || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua));
  const android = /Android/.test(ua);
  const steps = ios
    ? `<ol>
<li>Нажмите <a class="btn" href="/ca.crt">Скачать сертификат</a> → «Разрешить». Появится «Профиль загружен».</li>
<li>Откройте <b>Настройки</b> → вверху «Профиль загружен» → <b>Установить</b> (введите код телефона).</li>
<li><b>Настройки → Основные → Об этом устройстве → Доверие сертификатам</b> → включите «BurstCam Local CA».</li>
<li>Вернитесь в Safari и откройте <a class="btn" href="${httpsUrl}">${httpsUrl}</a></li>
<li>Чтобы было как приложение: кнопка «Поделиться» → <b>На экран «Домой»</b>.</li>
</ol>`
    : `<ol>
<li>Нажмите <a class="btn" href="/ca.crt">Скачать сертификат</a>.</li>
<li>Если Chrome не предложил установку сам: <b>Настройки → Безопасность → Дополнительно → Шифрование и учётные данные → Установка сертификата → Сертификат ЦС</b> → «Всё равно установить» → выберите <i>BurstCam-CA.crt</i> из «Загрузок». (На разных телефонах путь чуть отличается — ищите в настройках «сертификат ЦС».)</li>
<li>Откройте <a class="btn" href="${httpsUrl}">${httpsUrl}</a> в Chrome.</li>
<li>Меню ⋮ → <b>Установить приложение</b> (или «Добавить на гл. экран»).</li>
</ol>`;
  const other = ios ? '' : android ? '' : '<p>Откройте эту страницу на телефоне — инструкция подстроится под iPhone или Android.</p>';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BurstCam — подключение телефона</title>
<style>
:root{color-scheme:light dark;--bg:#0b0b0c;--fg:#f2f2f3;--mut:#9a9aa2;--acc:#ffd23f}
body{margin:0;padding:20px 16px 40px;font:16px/1.5 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg)}
h1{font-size:22px;margin:0 0 4px} p{color:var(--mut)} li{margin:10px 0}
a.btn{display:inline-block;background:var(--acc);color:#111;padding:6px 12px;border-radius:10px;text-decoration:none;font-weight:600;word-break:break-all}
code{background:#222;padding:2px 6px;border-radius:6px}
.box{border:1px solid #333;border-radius:14px;padding:12px 14px;margin-top:18px}
</style></head><body>
<h1>BurstCam</h1>
<p>Камере в браузере нужен защищённый адрес (HTTPS). Один раз установите сертификат этого ноутбука — дальше всё открывается сразу.</p>
${other}${steps}
<div class="box"><b>Это безопасно?</b> Сертификат умеет подтверждать <i>только</i> адреса домашних и локальных сетей (192.168.*, 10.*, 172.16–31.*, 100.64–127.*) и имя localhost. Подделать им сайт банка или почты нельзя — телефон такое отвергнет. Удалить: на iPhone — Настройки → Основные → VPN и управление устройством; на Android — Учётные данные пользователя.</div>
<div class="box">Уже установили? Сразу: <a class="btn" href="${httpsUrl}">${httpsUrl}</a></div>
</body></html>`;
}

function httpHandler(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/ca.crt') return serveCA(res);
  if (p === '/health') return send(res, 200, 'ok');
  send(res, 200, landing(req), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
}

// ---------- Запуск ----------

const ca = loadOrCreateCA(ROOT);
let current = issueServerCert(ca, listAddresses().map((a) => a.address));

const httpsServer = https.createServer({ cert: current.certPem + ca.certPem, key: current.keyPem }, (req, res) => {
  noteClient(req);
  serveApp(req, res);
});
const httpServer = http.createServer((req, res) => {
  noteClient(req);
  httpHandler(req, res);
});

const seenClients = new Set();
function noteClient(req) {
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  if (ip && ip !== '127.0.0.1' && ip !== '::1' && !seenClients.has(ip)) {
    seenClients.add(ip);
    log(`\n  → Подключилось устройство ${ip} (${req.socket.encrypted ? 'HTTPS' : 'HTTP'})`);
  }
}

let qr = null;
try { qr = (await import('qrcode-terminal')).default; } catch { /* QR — необязательно */ }

function banner() {
  const addrs = listAddresses();
  log('\n================ BurstCam запущен ================');
  if (ca.created) log('  Создан новый сертификат CA: .certs/ca.crt — его нужно один раз поставить на телефон.');
  log(`  CA SHA-256: ${fingerprint(ca.certPem).slice(0, 23)}…`);
  if (!addrs.length) {
    log('\n  Сетевых адресов нет. Подключите телефон к точке доступа ноутбука (или ноутбук к телефону) —');
    log('  адрес появится здесь сам, перезапускать не нужно.');
  }
  addrs.forEach((a, i) => {
    log(`\n  [${a.ifname}] ${a.label}${a.virtual ? ' (VPN или виртуальный адаптер — телефон в точке доступа его не видит)' : ''}`);
    log(`    1) Первый раз — установка сертификата:  http://${a.address}:${HTTP_PORT}/`);
    log(`    2) Приложение:                          https://${a.address}:${HTTPS_PORT}/`);
    if (i === 0 && qr && !a.virtual) {
      log('\n    QR для первого шага (наведите камеру телефона):');
      qr.generate(`http://${a.address}:${HTTP_PORT}/`, { small: true }, (s) => log(s.replace(/^/gm, '      ')));
    }
  });
  log('\n  На этом ноутбуке: https://localhost:' + HTTPS_PORT + '/');
  log('  Остановить: Ctrl+C');
  log('==================================================\n');
}

// Новые адреса (включили точку доступа после запуска) — перевыпускаем сертификат на лету.
setInterval(() => {
  const ips = listAddresses().map((a) => a.address);
  const fresh = ips.filter((ip) => !current.ips.includes(ip));
  if (fresh.length) {
    current = issueServerCert(ca, ips);
    httpsServer.setSecureContext({ cert: current.certPem + ca.certPem, key: current.keyPem });
    log(`\n  Новый адрес: ${fresh.join(', ')} — сертификат обновлён.`);
    banner();
  }
}, 4000).unref();

function listen(server, port, name) {
  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        reject(new Error(`Порт ${port} (${name}) занят. Уже запущен другой BurstCam? Закройте его окно или запустите с --${name === 'HTTPS' ? 'port' : 'http'} <другой порт>.`));
      } else reject(e);
    });
    server.listen(port, '0.0.0.0', resolve);
  });
}

try {
  await listen(httpsServer, HTTPS_PORT, 'HTTPS');
  await listen(httpServer, HTTP_PORT, 'HTTP');
} catch (e) {
  console.error('\n  ОШИБКА: ' + e.message + '\n');
  process.exit(1);
}
banner();
if (process.send) process.send({ ready: true, httpsPort: HTTPS_PORT, httpPort: HTTP_PORT });

// Приём журнала с телефонов: POST /api/log → logs/ГГГГ-ММ-ДД.jsonl (по строке JSON на событие).
// Журнал не покидает ноутбук. Фото не передаются — только события, ошибки и сведения о камере.
import fs from 'node:fs';
import path from 'node:path';

const MAX_BODY = 512 * 1024;
const MAX_ENTRIES = 500;

export function createLogSink({ dir, echo = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = () => path.join(dir, new Date().toISOString().slice(0, 10) + '.jsonl');

  /** Обработать запрос; true — если это был /api/log. */
  return function handle(req, res) {
    const url = new URL(req.url, 'https://x');
    if (url.pathname !== '/api/log') return false;
    if (req.method !== 'POST') { res.writeHead(405).end(); return true; }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
      const entries = Array.isArray(body.entries) ? body.entries.slice(0, MAX_ENTRIES) : [];
      const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
      const meta = { ip, session: String(body.session || '').slice(0, 40), page: String(body.page || '').slice(0, 40) };
      const lines = entries.map((e) => JSON.stringify({ at: new Date().toISOString(), ...meta, ...sanitize(e) })).join('\n');
      if (lines) fs.appendFile(file(), lines + '\n', () => {});
      for (const e of entries) {
        if (e && (e.level === 'error' || e.kind === 'error')) echo(`  [${ip}] ошибка: ${String(e.msg || e.data?.message || '').slice(0, 200)}`);
      }
      res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
    });
    return true;
  };
}

function sanitize(e) {
  if (!e || typeof e !== 'object') return { msg: String(e) };
  const s = JSON.stringify(e);
  return s.length > 64 * 1024 ? { kind: e.kind, msg: 'запись урезана', size: s.length } : e;
}

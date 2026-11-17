// Рисует иконки приложения в PNG без сторонних библиотек: node tools/make-icons.js
// Рисунок: жёлтое кольцо затвора на чёрном и «стопка» кадров — намёк на серию.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'icons');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Цвет точки (u,v ∈ [0,1]) — векторный рисунок, считаемый попиксельно. */
function shade(u, v, { pad, rounded }) {
  // Фон.
  const r = 0.22;
  const inRounded = (() => {
    if (!rounded) return true;
    const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
    const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
    return dx * dx + dy * dy <= r * r;
  })();
  if (!inRounded) return [0, 0, 0, 0];
  let col = [10, 10, 12, 255];
  const s = 1 - 2 * pad; // масштаб рисунка внутри безопасной зоны
  const x = (u - 0.5) / s + 0.5, y = (v - 0.5) / s + 0.5;

  // Стопка кадров (две рамки сзади-справа сверху).
  const frame = (ox, oy, a) => {
    const fx = x - ox, fy = y - oy;
    const inside = fx > 0.2 && fx < 0.8 && fy > 0.2 && fy < 0.8;
    const inner = fx > 0.235 && fx < 0.765 && fy > 0.235 && fy < 0.765;
    if (inside && !inner) col = mix(col, [255, 255, 255, 255], a);
  };
  frame(0.09, -0.09, 0.22);
  frame(0.045, -0.045, 0.45);

  // Кольцо затвора.
  const d = Math.hypot(x - 0.5, y - 0.5);
  if (d < 0.3) col = [10, 10, 12, 255];
  if (d >= 0.255 && d <= 0.3) col = [255, 210, 63, 255];
  if (d < 0.215) col = [255, 210, 63, 255];
  return col;
}

const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));

function render(size, opts) {
  const SS = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, opts);
          acc[0] += c[0] * c[3]; acc[1] += c[1] * c[3]; acc[2] += c[2] * c[3]; acc[3] += c[3];
        }
      }
      const o = (py * size + px) * 4;
      const a = acc[3] / (SS * SS);
      buf[o] = acc[3] ? Math.round(acc[0] / acc[3]) : 0;
      buf[o + 1] = acc[3] ? Math.round(acc[1] / acc[3]) : 0;
      buf[o + 2] = acc[3] ? Math.round(acc[2] / acc[3]) : 0;
      buf[o + 3] = Math.round(a);
    }
  }
  return png(size, size, buf);
}

fs.mkdirSync(OUT, { recursive: true });
const jobs = [
  ['icon-192.png', 192, { pad: 0.04, rounded: true }],
  ['icon-512.png', 512, { pad: 0.04, rounded: true }],
  ['icon-maskable-512.png', 512, { pad: 0.14, rounded: false }], // безопасная зона 80 %
  ['apple-touch-icon.png', 180, { pad: 0.06, rounded: false }], // iOS скругляет сам, прозрачность нельзя
];
for (const [name, size, opts] of jobs) {
  fs.writeFileSync(path.join(OUT, name), render(size, opts));
  console.log('icons/' + name);
}

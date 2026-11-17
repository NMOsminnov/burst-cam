// Сжатие кадра в JPEG + миниатюра. Один код для воркера (OffscreenCanvas) и главного потока
// (запасной путь для старых iOS, где OffscreenCanvas.convertToBlob нет).
//
// Почему не WASM-кодер (mozjpeg/jpeg-turbo в WebAssembly): браузер уже кодирует JPEG нативным
// libjpeg-turbo (Chromium) или ImageIO (Safari) с SIMD — WASM-сборка того же медленнее в 1,5–3 раза
// и добавляет копирование пикселей из GPU в память WASM. Подробно — docs/ANALIZ.md.
import { JPEG_QUALITY, THUMB_EDGE, THUMB_QUALITY } from './config.js';

/** Фабрика холстов: в воркере — OffscreenCanvas, в окне — <canvas>. Холсты переиспользуются. */
export function canvasKit() {
  const offscreen = typeof OffscreenCanvas !== 'undefined';
  const pool = {};
  const get = (slot, w, h) => {
    let c = pool[slot];
    if (!c) {
      c = offscreen ? new OffscreenCanvas(w, h) : document.createElement('canvas');
      pool[slot] = c;
    }
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    return c;
  };
  const toBlob = (c, type, quality) =>
    offscreen && c.convertToBlob
      ? c.convertToBlob({ type, quality })
      : new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob вернул null'))), type, quality));
  return { get, toBlob, offscreen };
}

const ctx2d = (c, opts) => c.getContext('2d', opts);

/**
 * Обработать задание кодировщика.
 * job: { id, seriesId, idx, createdAt, width, height, bitmap? , still?: Blob, ref?: ImageBitmap }
 */
export async function encodeJob(job, kit) {
  const t0 = performance.now();
  let src = job.bitmap;
  let rotation = 0;
  let passthrough = null;
  let source = 'frame';

  if (job.still) {
    source = 'still';
    try {
      const decoded = await createImageBitmap(job.still, { imageOrientation: 'from-image' });
      rotation = job.ref ? matchRotation(decoded, job.ref, kit) : 0;
      if (rotation === 0 && job.still.type === 'image/jpeg') passthrough = job.still; // без пересжатия
      src = decoded;
      job.ref?.close?.();
    } catch (e) {
      // Снимок не декодируется — берём кадр-образец.
      src = job.ref;
      source = 'frame';
    }
  }

  const sw = src.width ?? src.displayWidth;
  const sh = src.height ?? src.displayHeight;
  const quarter = rotation === 90 || rotation === 270;
  const w = quarter ? sh : sw;
  const h = quarter ? sw : sh;

  let blob = passthrough;
  if (!blob) {
    const full = kit.get('full', w, h);
    const fc = ctx2d(full, { alpha: false });
    drawRotated(fc, src, sw, sh, rotation);
    blob = await kit.toBlob(full, 'image/jpeg', JPEG_QUALITY);
  }

  // Миниатюра.
  const k = Math.min(1, THUMB_EDGE / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * k));
  const th = Math.max(1, Math.round(h * k));
  const tc = kit.get('thumb', tw, th);
  const tctx = ctx2d(tc, { alpha: false });
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = 'high';
  tctx.save();
  tctx.scale(k, k);
  drawRotated(tctx, src, sw, sh, rotation);
  tctx.restore();
  const thumb = await kit.toBlob(tc, 'image/jpeg', THUMB_QUALITY);
  src.close?.();

  return {
    meta: {
      id: job.id,
      seriesId: job.seriesId,
      idx: job.idx,
      createdAt: job.createdAt,
      width: w,
      height: h,
      bytes: blob.size,
      type: blob.type,
      source,
      encodeMs: Math.round(performance.now() - t0),
      thumb,
    },
    blob,
  };
}

function drawRotated(ctx, src, sw, sh, rotation) {
  ctx.save();
  if (rotation === 90) { ctx.translate(sh, 0); ctx.rotate(Math.PI / 2); }
  else if (rotation === 180) { ctx.translate(sw, sh); ctx.rotate(Math.PI); }
  else if (rotation === 270) { ctx.translate(0, sw); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(src, 0, 0, sw, sh);
  ctx.restore();
}

/**
 * Chrome на части Android-телефонов отдаёт takePhoto() повёрнутым (ориентация сенсора).
 * Сравниваем крошечные серые копии снимка в 4 поворотах с кадром потока, снятым в тот же миг,
 * и берём поворот с наибольшей корреляцией. 180° принимаем только при явном перевесе.
 */
export function matchRotation(img, ref, kit) {
  const N = 24;
  const sample = (src, rot) => {
    const c = kit.get('probe', N, N);
    const ctx = ctx2d(c, { willReadFrequently: true });
    const sw = src.width ?? src.displayWidth;
    const sh = src.height ?? src.displayHeight;
    const quarter = rot === 90 || rot === 270;
    ctx.save();
    ctx.scale(N / (quarter ? sh : sw), N / (quarter ? sw : sh));
    drawRotated(ctx, src, sw, sh, rot);
    ctx.restore();
    const d = ctx.getImageData(0, 0, N, N).data;
    const g = new Float32Array(N * N);
    for (let i = 0; i < g.length; i++) g[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
    return g;
  };
  const r = sample(ref, 0);
  const iw = img.width, ih = img.height;
  const rw = ref.width ?? ref.displayWidth, rh = ref.height ?? ref.displayHeight;
  const sameShape = (iw >= ih) === (rw >= rh);
  const candidates = sameShape ? [0, 180] : [90, 270];
  const scores = candidates.map((rot) => correlation(sample(img, rot), r));
  if (sameShape) return scores[1] > scores[0] + 0.25 ? 180 : 0;
  return scores[0] >= scores[1] ? 90 : 270;
}

export function correlation(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// Полноразмерный снимок через ImageCapture.takePhoto() — родной фотоконвейер камеры
// (полное разрешение сенсора, шумодав, автоэкспозиция для фото). Медленный (0,3–1,5 с),
// поэтому только для одиночного нажатия; серия всегда идёт из видеопотока.
import { STILL_GAIN, STILL_TIMEOUT_MS } from '../core/config.js';

/**
 * Подготовить takePhoto для дорожки. Возвращает null, если API нет или выигрыша в разрешении нет.
 * @returns {Promise<null | {width: number, height: number, take: () => Promise<Blob|null>}>}
 */
export async function setupStill(track) {
  if (typeof ImageCapture === 'undefined') return null;
  let ic;
  try { ic = new ImageCapture(track); } catch { return null; }
  if (typeof ic.takePhoto !== 'function') return null;
  let pc = null;
  try { pc = await withTimeout(ic.getPhotoCapabilities(), 3000); } catch { /* бывает не реализовано */ }
  const s = track.getSettings();
  const streamPx = (s.width || 0) * (s.height || 0);
  const maxW = pc?.imageWidth?.max || 0;
  const maxH = pc?.imageHeight?.max || 0;
  if (!maxW || !maxH) return null;
  if (maxW * maxH < STILL_GAIN * streamPx) return null; // поток уже не хуже — takePhoto не нужен
  const settings = { imageWidth: maxW, imageHeight: maxH };
  return {
    width: maxW,
    height: maxH,
    async take() {
      if (track.readyState !== 'live') return null;
      try {
        const blob = await withTimeout(ic.takePhoto(settings), STILL_TIMEOUT_MS);
        return blob && blob.size > 0 ? blob : null;
      } catch {
        return null;
      }
    },
  };
}

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

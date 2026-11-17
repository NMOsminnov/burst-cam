// Родной снимок камеры через ImageCapture.takePhoto(): полное разрешение сенсора и фотообработка
// телефона. Медленный (0,3–1,5 с), и спецификация разрешает браузеру отклонять вызовы подряд
// (UnknownError) — поэтому снимки идут строго по очереди, а касания не ждут друг друга:
// каждое касание сразу берёт кадр-образец момента, родной снимок догоняет его в очереди.
import { STILL_TIMEOUT_MS } from '../core/config.js';

/** Сколько родных снимков может ждать в очереди; дальше касание сохраняет кадр потока. */
export const STILL_QUEUE_MAX = 4;

/**
 * Режимы родного снимка по возможностям камеры.
 * Возвращает [{id, width, height, label}] — от большего к меньшему.
 */
export function stillModes(pc) {
  const maxW = pc?.imageWidth?.max || 0;
  const maxH = pc?.imageHeight?.max || 0;
  if (!maxW || !maxH) return [];
  const [L, S] = maxW >= maxH ? [maxW, maxH] : [maxH, maxW];
  const out = [{ id: 'max', width: L, height: S }];
  // Сенсоры 48–200 Мп снимают «с объединением пикселей» в 12–50 Мп: в темноте это обычно
  // чище полного разрешения. Предлагаем половину сторон, если она не меньше 8 Мп.
  const half = [Math.round(L / 2), Math.round(S / 2)];
  if (half[0] * half[1] >= 8e6) out.push({ id: 'half', width: half[0], height: half[1] });
  for (const m of out) m.mp = (m.width * m.height) / 1e6;
  return out;
}

/**
 * @param {MediaStreamTrack} track
 * @param {{mode?: 'max'|'half'}} [opts]
 * @returns {Promise<null | {modes, mode, width, height, gain, pending: number, take: () => Promise<Blob|null>, busy: boolean}>}
 */
export async function setupStill(track, { mode = 'max' } = {}) {
  if (typeof ImageCapture === 'undefined') return null;
  let ic;
  try { ic = new ImageCapture(track); } catch { return null; }
  if (typeof ic.takePhoto !== 'function') return null;
  let pc = null;
  try { pc = await withTimeout(ic.getPhotoCapabilities(), 3000); } catch { /* бывает не реализовано */ }
  const modes = stillModes(pc);
  if (!modes.length) return null;
  const chosen = modes.find((m) => m.id === mode) || modes[0];
  const s = track.getSettings();
  const streamPx = (s.width || 1) * (s.height || 1);
  // Ширину и высоту передаём в ориентации, которую камера сама сообщила.
  const portraitCaps = (pc.imageHeight.max || 0) > (pc.imageWidth.max || 0);
  const settings = portraitCaps
    ? { imageWidth: chosen.height, imageHeight: chosen.width }
    : { imageWidth: chosen.width, imageHeight: chosen.height };

  let chain = Promise.resolve();
  const still = {
    modes,
    mode: chosen.id,
    width: chosen.width,
    height: chosen.height,
    gain: (chosen.width * chosen.height) / streamPx,
    pending: 0,
    get full() { return this.pending >= STILL_QUEUE_MAX; },
    /** Поставить снимок в очередь. Возвращает Blob или null (не вышло — нужен кадр потока). */
    take() {
      this.pending++;
      const run = async () => {
        try {
          if (track.readyState !== 'live') return null;
          const blob = await withTimeout(ic.takePhoto(settings), STILL_TIMEOUT_MS);
          return blob && blob.size > 0 ? blob : null;
        } catch {
          return null;
        } finally {
          this.pending--;
        }
      };
      const p = chain.then(run, run);
      chain = p.catch(() => null);
      return p;
    },
  };
  return still;
}

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

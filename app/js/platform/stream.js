// Открытие камеры в максимальном разрешении, при котором поток держит частоту для серии.
import { RESOLUTION_LADDER, MIN_STREAM_FPS } from '../core/config.js';

const CACHE_KEY = 'burstcam.mode.v1';

function cacheGet(key) {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')[key] || null; } catch { return null; }
}
function cacheSet(key, value) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    all[key] = value;
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch { /* приватный режим */ }
}

/** Ступени лестницы, которые камера в принципе может дать (по getCapabilities). */
export function feasibleLadder(caps, ladder = RESOLUTION_LADDER) {
  const W = caps?.width?.max;
  const H = caps?.height?.max;
  if (!W || !H) return ladder.slice();
  const long = Math.max(W, H);
  const short = Math.min(W, H);
  const out = ladder.filter(([l, s]) => l <= long && s <= short);
  return out.length ? out : ladder.slice(-1);
}

const px = (s) => (s.width || 0) * (s.height || 0);

/**
 * Открыть камеру.
 * @param {object} o
 * @param {'environment'|'user'} o.facing
 * @param {string} [o.deviceId]
 * @param {(msg: string) => void} [o.status]
 */
export async function openStream({ facing, deviceId, status = () => {} }) {
  const cacheKey = `${facing}:${deviceId || ''}:${screen.width}x${screen.height}`;
  const cached = cacheGet(cacheKey);
  const base = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: facing } };

  const first = cached ? { width: { ideal: cached[0] }, height: { ideal: cached[1] } } : { width: { ideal: 1920 }, height: { ideal: 1080 } };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, ...first, frameRate: { ideal: 30 } } });
  } catch (e) {
    if (e.name === 'OverconstrainedError') {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: base });
    } else throw e;
  }
  const track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  if (cached) {
    const s = track.getSettings();
    if (px(s) >= 0.9 * cached[0] * cached[1]) return { stream, track, caps, settings: s, fromCache: true };
  }

  status('Подбираю максимальное разрешение…');
  let best = track.getSettings();
  const tried = new Set([`${best.width}x${best.height}`]);
  for (const [L, S] of feasibleLadder(caps)) {
    if (L * S <= px(best)) break; // дальше только хуже текущего
    for (const [w, h] of [[L, S], [S, L]]) {
      try {
        await track.applyConstraints({ width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } });
      } catch { continue; }
      const s = track.getSettings();
      const key = `${s.width}x${s.height}`;
      if (tried.has(key)) continue;
      tried.add(key);
      const okFps = !s.frameRate || s.frameRate >= MIN_STREAM_FPS;
      if (px(s) > px(best) && okFps) best = s;
      if (px(s) >= 0.9 * L * S && okFps) break;
    }
    if (px(best) >= 0.9 * L * S) break;
  }
  // Вернуть лучшее из увиденного (последний applyConstraints мог дать худшее).
  const now = track.getSettings();
  if (now.width !== best.width || now.height !== best.height) {
    try { await track.applyConstraints({ width: { ideal: best.width }, height: { ideal: best.height }, frameRate: { ideal: 30 } }); } catch { /* оставим как есть */ }
  }
  const settings = track.getSettings();
  const long = Math.max(settings.width, settings.height);
  const short = Math.min(settings.width, settings.height);
  cacheSet(cacheKey, [long, short]);
  return { stream, track, caps, settings, fromCache: false };
}

/** Понизить разрешение на ступень (если реальная частота кадров оказалась низкой). */
export async function stepDown(track, caps, facing, deviceId) {
  const s = track.getSettings();
  const cur = s.width * s.height;
  const next = feasibleLadder(caps).find(([l, sh]) => l * sh < cur * 0.85);
  if (!next) return false;
  const portrait = s.height > s.width;
  const [w, h] = portrait ? [next[1], next[0]] : next;
  try {
    await track.applyConstraints({ width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } });
  } catch { return false; }
  const n = track.getSettings();
  cacheSet(`${facing}:${deviceId || ''}:${screen.width}x${screen.height}`, [Math.max(n.width, n.height), Math.min(n.width, n.height)]);
  return true;
}

/** Реальная частота кадров <video> за окно ms (по requestVideoFrameCallback). */
export function measureFps(video, ms = 700) {
  return new Promise((resolve) => {
    if (!('requestVideoFrameCallback' in video)) { resolve(null); return; }
    let n = 0;
    let t0 = null;
    let stop = false;
    const cb = (now) => {
      if (stop) return;
      if (t0 == null) t0 = now; else n++;
      if (now - t0 >= ms) { stop = true; resolve((n * 1000) / (now - t0)); return; }
      video.requestVideoFrameCallback(cb);
    };
    video.requestVideoFrameCallback(cb);
    setTimeout(() => { if (!stop) { stop = true; resolve(n ? (n * 1000) / ms : 0); } }, ms + 1500);
  });
}

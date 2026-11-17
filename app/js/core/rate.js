// Чистая логика темпа серии и бюджета памяти — без DOM, проверяется юнит-тестами.
import { PIXEL_RATE, MIN_FPS, MAX_FPS } from './config.js';

/** Интервал между кадрами серии (мс) для кадра w×h. */
export function burstIntervalMs(w, h, streamFps = 30) {
  const px = Math.max(1, w * h);
  const fps = Math.min(MAX_FPS, Math.max(MIN_FPS, PIXEL_RATE / px), streamFps || MAX_FPS);
  return 1000 / fps;
}

/**
 * Брать ли кадр со временем t, если прошлый взят в lastT.
 * Допуск в полкадра потока: при потоке 30 к/с и интервале 100 мс кадры идут через 99–101 мс,
 * и без допуска мы бы брали каждый 4-й кадр (7,5 к/с) вместо каждого 3-го.
 */
export function dueForFrame(t, lastT, intervalMs, frameDurMs = 33) {
  if (lastT == null) return true;
  return t - lastT >= intervalMs - frameDurMs / 2;
}

/** Байт на кадр в очереди (RGBA). */
export const frameBytes = (w, h) => w * h * 4;

/**
 * Бюджет памяти под очередь ещё не сжатых кадров.
 * deviceMemory есть только в Chromium (Android) и округлён до 0.25..8 ГБ.
 * На iOS его нет; Safari выгружает вкладку примерно после 1–1,5 ГБ, держим запас.
 */
export function queueBudgetBytes({ platform, deviceMemoryGB }) {
  const MB = 1024 * 1024;
  if (platform === 'ios') return 300 * MB;
  const gb = deviceMemoryGB || 4;
  return Math.min(900 * MB, Math.max(160 * MB, gb * 1024 * MB * 0.11));
}

/** Сколько кодировщиков-воркеров заводить. */
export function encoderCount({ platform, cores }) {
  const c = cores || 4;
  const cap = platform === 'ios' ? 3 : 4;
  return Math.max(1, Math.min(cap, c - 1));
}

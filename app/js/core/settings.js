// Настройки съёмки, которые выбирает человек. Хранятся в localStorage этого телефона.

const KEY = 'burstcam.settings.v1';

export const QUALITY = {
  max: { q: 0.98, label: 'Максимальное', hint: 'почти без сжатия, файлы в 2–3 раза больше' },
  high: { q: 0.92, label: 'Высокое', hint: 'на глаз не отличить от максимального' },
  compact: { q: 0.85, label: 'Компактное', hint: 'меньше места, быстрее серия' },
};

export const DEFAULTS = {
  facing: 'environment',
  deviceId: null, // выбранный объектив (null — какой даст браузер)
  streamMode: {}, // ключ объектива → [длинная, короткая] или отсутствует (автоподбор)
  tapMode: 'native', // 'native' — родной снимок камеры, если есть; 'stream' — мгновенный кадр потока
  stillSize: 'max', // 'max' | 'half'
  quality: 'high',
};

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEFAULTS, ...s, streamMode: { ...(s.streamMode || {}) } };
  } catch {
    return { ...DEFAULTS, streamMode: {} };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* приватный режим */ }
}

export const jpegQuality = (s) => (QUALITY[s.quality] || QUALITY.high).q;

export function lensKey(facing, deviceId) {
  return `${facing}:${deviceId || 'default'}`;
}

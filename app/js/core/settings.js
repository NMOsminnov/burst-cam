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
  streamMode: {}, // ключ объектива → [длинная, короткая], выбранный человеком
  autoMode: {}, // ключ объектива → режим, найденный автоопросом (при нём родной снимок крупнее всего)
  zoom: {}, // ключ объектива → приближение (на камерах с большим сенсором зум даёт больше деталей вдали)
  v: 2,
  // 'auto' — родной снимок, если он заметно крупнее кадра потока, иначе мгновенный кадр;
  // 'native' — всегда родной снимок (медленнее, возможен смаз); 'stream' — всегда мгновенный кадр.
  tapMode: 'auto',
  stillSize: 'max', // 'max' | 'half'
  quality: 'high',
};

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    // v1 сохранял «родной снимок» по умолчанию, не по выбору человека — переводим на «Авто».
    if ((s.v || 1) < 2) { if (s.tapMode === 'native') s.tapMode = 'auto'; s.v = 2; }
    return { ...DEFAULTS, ...s, streamMode: { ...(s.streamMode || {}) }, autoMode: { ...(s.autoMode || {}) }, zoom: { ...(s.zoom || {}) } };
  } catch {
    return { ...DEFAULTS, streamMode: {}, autoMode: {}, zoom: {} };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* приватный режим */ }
}

export const jpegQuality = (s) => (QUALITY[s.quality] || QUALITY.high).q;

export function lensKey(facing, deviceId) {
  return `${facing}:${deviceId || 'default'}`;
}

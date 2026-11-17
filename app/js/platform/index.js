// Выбор платформенного модуля. Можно принудить параметром ?engine=android|ios|generic
// (для проверки на компьютере и в тестах).
import { android } from './android.js';
import { ios } from './ios.js';
import { queueBudgetBytes, encoderCount } from '../core/rate.js';

/** Запасной модуль для прочих браузеров (Firefox и т. п.): кадры из <video>, без takePhoto. */
export const generic = {
  id: 'generic',
  label: 'Браузер без особых API',
  matches: () => true,
  budget: () => queueBudgetBytes({ platform: 'android', deviceMemoryGB: navigator.deviceMemory || 2 }),
  encoders: () => encoderCount({ platform: 'android', cores: navigator.hardwareConcurrency }),
  sourcePlan: () => ['main'],
  setupStill: async () => null,
  haptic: (k) => navigator.vibrate?.(k === 'burst' ? 18 : 8),
  focusSupported: () => false,
  focusAt: async () => {},
};

export function pickPlatform(search = location.search) {
  const forced = new URLSearchParams(search).get('engine');
  const all = { android, ios, generic };
  if (forced && all[forced]) return all[forced];
  if (ios.matches()) return ios;
  if (android.matches()) return android;
  return generic;
}

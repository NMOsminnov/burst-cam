// Модуль iOS (Safari и любой браузер на iPhone — все они WebKit).
//
// Особенности WebKit, под которые он написан:
//  • MediaStreamTrackProcessor есть только в воркере (Safari 18+), и туда передаётся сама
//    дорожка (transferable MediaStreamTrack). На iOS 15–17 — кадры из <video> по
//    requestVideoFrameCallback (Safari 15.4+);
//  • нет navigator.deviceMemory, а вкладку выгружают примерно после 1–1,5 ГБ: бюджет очереди
//    фиксированный и осторожный (300 МБ ≈ 9 кадров 4K в ожидании сжатия);
//  • OffscreenCanvas.convertToBlob — с iOS 16.4; на более старых кодируем в главном потоке;
//  • ImageCapture.takePhoto реализован в WebKit, но включён не во всех версиях — проверяем на лету;
//  • вибрации нет (navigator.vibrate отсутствует);
//  • в установленном на «Домой» приложении камера останавливается при сворачивании —
//    приложение переоткрывает поток при возврате (camera.js).
import { queueBudgetBytes, encoderCount } from '../core/rate.js';
import { setupStill } from './still.js';
import { isWebKit } from './android.js';

export const ios = {
  id: 'ios',
  label: 'iOS · WebKit',

  matches() {
    const ua = navigator.userAgent;
    const iDevice = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return iDevice || isWebKit();
  },

  budget() {
    return queueBudgetBytes({ platform: 'ios' });
  },

  encoders() {
    return encoderCount({ platform: 'ios', cores: navigator.hardwareConcurrency });
  },

  /** Сначала дорожка в воркер (Safari 18+), иначе кадры из <video>. */
  sourcePlan() {
    return ['worker:track', 'main'];
  },

  setupStill,

  haptic() { /* в Safari нет API вибрации */ },

  focusSupported(track) {
    const sup = navigator.mediaDevices.getSupportedConstraints?.() || {};
    const caps = track.getCapabilities?.() || {};
    return !!sup.pointsOfInterest && Array.isArray(caps.focusMode) && caps.focusMode.length > 0;
  },

  async focusAt(track, x, y) {
    await track.applyConstraints({ advanced: [{ pointsOfInterest: [{ x, y }] }] });
  },
};

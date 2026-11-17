// Модуль Android (Chrome, Samsung Internet, Edge, Яндекс — всё на Chromium).
//
// Что берём от Chromium:
//  • MediaStreamTrackProcessor в окне + передача его ReadableStream в воркер — сырые VideoFrame
//    без <video> и без участия главного потока;
//  • ImageCapture.takePhoto() — полноразмерное фото для одиночного нажатия;
//  • navigator.deviceMemory — бюджет очереди по реальной памяти телефона;
//  • zoom / torch / pointsOfInterest (фокус касанием) через applyConstraints;
//  • вибрация на старте серии.
import { queueBudgetBytes, encoderCount } from '../core/rate.js';
import { setupStill } from './still.js';

export const android = {
  id: 'android',
  label: 'Android · Chromium',

  matches() {
    return typeof window.MediaStreamTrackProcessor === 'function' && /Android|Linux|Windows|Mac|CrOS/.test(navigator.userAgent) && !isWebKit();
  },

  budget() {
    return queueBudgetBytes({ platform: 'android', deviceMemoryGB: navigator.deviceMemory });
  },

  encoders() {
    return encoderCount({ platform: 'android', cores: navigator.hardwareConcurrency });
  },

  /** Как доставлять кадры: процессор в окне, поток — в воркер. */
  sourcePlan() {
    return ['worker:readable', 'main'];
  },

  setupStill,

  haptic(kind) {
    if (!navigator.vibrate) return;
    navigator.vibrate(kind === 'burst' ? 18 : 8);
  },

  focusSupported(track) {
    const sup = navigator.mediaDevices.getSupportedConstraints?.() || {};
    const caps = track.getCapabilities?.() || {};
    return !!sup.pointsOfInterest && Array.isArray(caps.focusMode) && caps.focusMode.length > 0;
  },

  async focusAt(track, x, y) {
    const caps = track.getCapabilities?.() || {};
    const modes = caps.focusMode || [];
    const adv = { pointsOfInterest: [{ x, y }] };
    if (modes.includes('single-shot')) adv.focusMode = 'single-shot';
    if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes('continuous')) adv.exposureMode = 'continuous';
    await track.applyConstraints({ advanced: [adv] });
    // Через 4 с вернуть непрерывный автофокус, иначе следующий кадр может быть мимо.
    if (modes.includes('continuous')) {
      setTimeout(() => track.readyState === 'live' && track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}), 4000);
    }
  },
};

export function isWebKit() {
  const ua = navigator.userAgent;
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android/.test(ua);
}

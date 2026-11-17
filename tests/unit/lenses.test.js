import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLens, describeLenses } from '../../app/js/platform/lenses.js';
import { stillModes } from '../../app/js/platform/still.js';

const dev = (label, i) => ({ kind: 'videoinput', deviceId: 'd' + i, label });

test('iPhone: основная + ультраширик + фронтальная (была ошибка: основная звалась «Задняя 1»)', () => {
  const { lenses, ultraKnown } = describeLenses(['Back Camera', 'Back Ultra Wide Camera', 'Front Camera'].map(dev));
  assert.deepEqual(lenses.map((l) => l.name), ['Основная', 'Ультраширокая', 'Фронтальная']);
  assert.deepEqual(lenses.map((l) => l.short), ['1×', '0,5×', 'Фронт']);
  assert.equal(ultraKnown, true);
});

test('iPhone на русском и составные камеры', () => {
  assert.equal(classifyLens('Сверхширокоугольная камера на задней панели').kind, 'ultra');
  assert.equal(classifyLens('Back Triple Camera').kind, 'multi');
  assert.equal(classifyLens('Back Telephoto Camera').kind, 'tele');
  assert.equal(classifyLens('Передняя камера').facing, 'user');
});

test('Android: объективы без подписи нумеруются, фронтальная распознаётся', () => {
  const { lenses, backs, ultraKnown } = describeLenses(['camera2 0, facing back', 'camera2 1, facing front', 'camera2 2, facing back', 'camera2 3, facing back'].map(dev));
  assert.deepEqual(lenses.map((l) => l.name), ['Задняя 1', 'Фронтальная', 'Задняя 2', 'Задняя 3']);
  assert.equal(backs.length, 3);
  assert.equal(ultraKnown, false);
});

test('Android с одной логической камерой: основная без номера', () => {
  const { lenses } = describeLenses(['camera2 0, facing back', 'camera2 1, facing front'].map(dev));
  assert.deepEqual(lenses.map((l) => l.name), ['Основная', 'Фронтальная']);
});

test('режимы родного снимка: максимум и «с объединением пикселей» для больших сенсоров', () => {
  const m50 = stillModes({ imageWidth: { max: 8160 }, imageHeight: { max: 6120 } });
  assert.deepEqual(m50.map((m) => [m.id, m.width, m.height]), [['max', 8160, 6120], ['half', 4080, 3060]]);
  const m12 = stillModes({ imageWidth: { max: 4000 }, imageHeight: { max: 3000 } });
  assert.deepEqual(m12.map((m) => m.id), ['max'], '12 Мп пополам — 3 Мп, такой режим не предлагаем');
  assert.deepEqual(stillModes({}), []);
});

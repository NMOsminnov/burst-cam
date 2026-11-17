import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDefaultMode, sameMode, fpsTier } from '../../app/js/core/modes.js';

const m = (width, height, fps, photo = null) => ({ width, height, fps, photo });

test('по умолчанию — максимальная частота: 60 к/с важнее разрешения', () => {
  const best = pickDefaultMode([m(3840, 2160, 30), m(1920, 1080, 60), m(1280, 720, 60)]);
  assert.deepEqual([best.width, best.fps], [1920, 60]);
});

test('при одной частоте — максимальное разрешение (телефон автора: всё 30 к/с, берём 3264×2448)', () => {
  const author = [m(3264, 2448, 30, [3264, 2448]), m(2592, 1944, 30, [3264, 2448]), m(1920, 1080, 30, null)];
  assert.equal(pickDefaultMode(author).width, 3264);
});

test('при равных частоте и разрешении — крупнее родное фото; 29,97 и 30 — одна ступень', () => {
  const best = pickDefaultMode([m(1920, 1080, 29.97, [3264, 2448]), m(1920, 1080, 30, [4000, 3000])]);
  assert.deepEqual(best.photo, [4000, 3000]);
  assert.equal(fpsTier(29.97), fpsTier(30));
  assert.ok(sameMode(m(1920, 1080, 30), m(1920, 1080, 29.97)));
  assert.ok(!sameMode(m(1920, 1080, 30), m(1920, 1080, 60)));
  assert.equal(pickDefaultMode([]), null);
});

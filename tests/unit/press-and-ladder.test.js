import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPress } from '../../app/js/core/press.js';
import { feasibleLadder } from '../../app/js/platform/stream.js';
import { correlation } from '../../app/js/core/encode.js';

function fakeTimers() {
  const q = [];
  return {
    set: (fn, ms) => { const h = { fn, ms, on: true }; q.push(h); return h; },
    clear: (h) => { h.on = false; },
    fire: () => { for (const h of q) if (h.on) { h.on = false; h.fn(); } },
  };
}

test('касание: arm сразу, release single, серии нет', () => {
  const tm = fakeTimers();
  const log = [];
  const p = createPress({ holdMs: 260, setTimer: tm.set, clearTimer: tm.clear,
    onArm: (id) => log.push(['arm', id]), onBurst: (id) => log.push(['burst', id]), onRelease: (id, k) => log.push(['rel', id, k]) });
  p.down();
  p.up();
  tm.fire(); // таймер уже отменён
  assert.deepEqual(log, [['arm', 1], ['rel', 1, 'single']]);
});

test('удержание: серия начинается по таймеру, отпускание завершает её', () => {
  const tm = fakeTimers();
  const log = [];
  const p = createPress({ holdMs: 260, setTimer: tm.set, clearTimer: tm.clear,
    onArm: (id) => log.push(['arm', id]), onBurst: (id) => log.push(['burst', id]), onRelease: (id, k) => log.push(['rel', id, k]) });
  p.down();
  p.down(); // повторное нажатие (второй палец) игнорируется
  tm.fire();
  assert.equal(p.bursting, true);
  p.up();
  p.up();
  assert.deepEqual(log, [['arm', 1], ['burst', 1], ['rel', 1, 'burst']]);
});

test('лестница разрешений ограничена возможностями камеры в любой ориентации', () => {
  const portraitCaps = { width: { max: 2160 }, height: { max: 3840 } };
  const l = feasibleLadder(portraitCaps);
  assert.deepEqual(l[0], [3840, 2160]);
  assert.ok(l.every(([a, b]) => a <= 3840 && b <= 2160));
  assert.ok(feasibleLadder({}).length > 5, 'без getCapabilities — вся лестница');
  assert.deepEqual(feasibleLadder({ width: { max: 320 }, height: { max: 240 } }), [[1280, 720]]);
});

test('корреляция: совпадение = 1, инверсия = −1', () => {
  const a = Float32Array.from([1, 2, 3, 4, 5]);
  const b = Float32Array.from([5, 4, 3, 2, 1]);
  assert.ok(Math.abs(correlation(a, a) - 1) < 1e-6);
  assert.ok(Math.abs(correlation(a, b) + 1) < 1e-6);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, photoId } from '../../app/js/core/scheduler.js';
import { burstIntervalMs, dueForFrame, queueBudgetBytes } from '../../app/js/core/rate.js';

const MB = 1024 * 1024;
const bmp = (tag) => ({ tag, closed: false, close() { this.closed = true; } });

function rig({ budget = 1000 * MB, encoders = 2, maxBurst } = {}) {
  const posts = [];
  const events = [];
  const s = new Scheduler({
    encoders: Array.from({ length: encoders }, (_, i) => ({ post: (m) => posts.push({ i, m }) })),
    budgetBytes: budget,
    emit: (t, d) => events.push([t, d]),
    wallClock: () => 1000,
    maxBurst,
  });
  return { s, posts, events };
}

test('короткое нажатие: один кадр, взятый в момент касания', () => {
  const { s, posts, events } = rig();
  s.arm({ shotId: 1, seriesId: 'A' });
  assert.equal(s.wants(0), true);
  s.accept(bmp('f0'), 0, 1920, 1080);
  assert.equal(s.wants(33), false, 'после первого кадра в режиме ожидания кадры не нужны');
  s.single(1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].m.job.id, photoId('A', 0));
  assert.equal(posts[0].m.job.bitmap.tag, 'f0');
  assert.ok(events.some(([t, d]) => t === 'shot-end' && d.count === 1));
  assert.equal(s.wants(66), false);
});

test('отпустили раньше, чем пришёл первый кадр — фото всё равно будет', () => {
  const { s, posts } = rig();
  s.arm({ shotId: 1, seriesId: 'A' });
  s.single(1);
  assert.equal(posts.length, 0);
  assert.equal(s.wants(0), true);
  s.accept(bmp('late'), 0, 1920, 1080);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].m.job.bitmap.tag, 'late');
});

test('stop без single в фазе ожидания тоже делает одиночный снимок', () => {
  const { s, posts } = rig();
  s.arm({ shotId: 7, seriesId: 'Z' });
  s.accept(bmp('x'), 0, 640, 480);
  s.stop(7);
  assert.equal(posts.length, 1);
});

test('серия: кадр касания становится №0, далее по темпу 4K ≈ 10 к/с', () => {
  const { s, posts } = rig();
  s.arm({ shotId: 1, seriesId: 'B' });
  s.accept(bmp(0), 0, 3840, 2160);
  s.burst(1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].m.job.idx, 0);
  // Поток 30 к/с в течение секунды.
  for (let k = 1; k <= 30; k++) {
    const t = k * 33.33;
    if (s.wants(t)) s.accept(bmp(k), t, 3840, 2160);
  }
  const n = posts.length;
  assert.ok(n >= 10 && n <= 11, `за секунду ${n} кадров, ожидалось ~10`);
  assert.deepEqual(posts.map((p) => p.m.job.idx), [...Array(n).keys()]);
  s.stop(1);
  assert.equal(s.wants(2000), false);
});

test('кодировщики не успевают — кадры пропускаются, память не растёт сверх бюджета', () => {
  const frame = 1920 * 1080 * 4;
  const { s, posts } = rig({ budget: frame * 3 });
  s.arm({ shotId: 1, seriesId: 'C' });
  s.accept(bmp(0), 0, 1920, 1080);
  s.burst(1);
  for (let k = 1; k <= 60; k++) {
    const t = k * 33.33;
    if (s.wants(t)) s.accept(bmp(k), t, 1920, 1080);
  }
  assert.equal(posts.length, 3, 'в очереди не больше бюджета');
  assert.ok(s.dropped > 0);
  // Кодировщик освободился — серия продолжается.
  s.done(posts[0].i, frame);
  assert.equal(s.wants(3000), true);
});

test('предел длины серии', () => {
  const { s, posts, events } = rig({ maxBurst: 5 });
  s.arm({ shotId: 1, seriesId: 'D' });
  s.accept(bmp(0), 0, 640, 480);
  s.burst(1);
  for (let k = 1; k < 100; k++) if (s.wants(k * 100)) s.accept(bmp(k), k * 100, 640, 480);
  assert.equal(posts.length, 5);
  assert.ok(events.some(([t]) => t === 'limit'));
});

test('ожидание полноразмерного снимка: кадр — образец, при отказе — сам кадр', () => {
  const { s, posts } = rig();
  s.arm({ shotId: 1, seriesId: 'E' });
  s.accept(bmp('ref'), 0, 1920, 1080);
  s.single(1, { waitStill: true });
  assert.equal(posts.length, 0, 'ждём takePhoto');
  s.still(1, { size: 10, type: 'image/jpeg' });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].m.job.ref.tag, 'ref');
  assert.ok(posts[0].m.job.still);

  s.arm({ shotId: 2, seriesId: 'F' });
  s.accept(bmp('f'), 0, 1920, 1080);
  s.single(2, { waitStill: true });
  s.still(2, null);
  assert.equal(posts[1].m.job.bitmap.tag, 'f');
});

test('новое нажатие во время ожидания takePhoto не теряет прошлый снимок', () => {
  const { s, posts } = rig();
  s.arm({ shotId: 1, seriesId: 'G' });
  s.accept(bmp('g'), 0, 100, 100);
  s.single(1, { waitStill: true });
  s.arm({ shotId: 2, seriesId: 'H' });
  s.accept(bmp('h'), 10, 100, 100);
  s.single(2);
  s.still(1, null);
  assert.deepEqual(posts.map((p) => p.m.job.seriesId).sort(), ['G', 'H']);
});

test('кадры распределяются по свободным кодировщикам', () => {
  const { s, posts } = rig({ encoders: 3 });
  s.arm({ shotId: 1, seriesId: 'I' });
  s.accept(bmp(0), 0, 640, 480);
  s.burst(1);
  for (let k = 1; k < 6; k++) if (s.wants(k * 60)) s.accept(bmp(k), k * 60, 640, 480);
  const used = new Set(posts.map((p) => p.i));
  assert.equal(used.size, 3);
});

test('темп: 4K ≈ 10 к/с, 1080p упирается в 20 к/с, но не выше частоты потока', () => {
  assert.ok(Math.abs(1000 / burstIntervalMs(3840, 2160) - 10.1) < 0.2);
  assert.equal(1000 / burstIntervalMs(1920, 1080), 20);
  assert.equal(Math.round(1000 / burstIntervalMs(640, 480, 15)), 15);
  assert.equal(dueForFrame(99, 0, 100, 33), true, 'допуск в полкадра');
  assert.equal(dueForFrame(80, 0, 100, 33), false);
});

test('бюджет памяти: iOS фиксированный, Android по deviceMemory в пределах', () => {
  assert.equal(queueBudgetBytes({ platform: 'ios' }), 300 * MB);
  assert.equal(queueBudgetBytes({ platform: 'android', deviceMemoryGB: 0.5 }), 160 * MB);
  assert.equal(queueBudgetBytes({ platform: 'android', deviceMemoryGB: 8 }), 900 * MB);
});

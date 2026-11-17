// Защита от смаза (автор, 17.11: «Да, сделай» — ограничить выдержку 1/30 с, яркость за счёт ISO).
// Поддельная камера с &dark=1 ведёт себя как телефон автора в помещении: автоматика держит 40 мс.
import { test, expect } from '@playwright/test';
import { q, openApp } from './helpers.js';

const fake = (more = '') => [q() ? '' : 'fake=1920x1080', more].filter(Boolean).join('&');
const exposure = (page) => page.evaluate(() => {
  const s = window.burstcam.camera.track.getSettings();
  return { mode: s.exposureMode, time: s.exposureTime, iso: s.iso, guard: window.burstcam.camera.guard?.state };
});

test('полумрак: выдержка ограничена 1/30 с, ISO поднят, кадр не потемнел', async ({ page }) => {
  test.skip(!!q(), 'достаточно одного прогона');
  await openApp(page, fake('dark=1'));
  await expect.poll(() => exposure(page), { timeout: 15_000 }).toMatchObject({ mode: 'manual', guard: 'manual' });
  const e = await exposure(page);
  expect(e.time).toBeLessThanOrEqual(334);
  expect(e.iso).toBeGreaterThan(100);
  // Яркость сохранена: свет выдержка × ISO не меньше, чем был у автоматики (400 × 100).
  expect(e.time * e.iso).toBeGreaterThan(400 * 100 * 0.85);
});

test('зум от 2× — выдержка не длиннее 1/60 с', async ({ page }) => {
  test.skip(!!q(), 'достаточно одного прогона');
  await openApp(page, fake('dark=1'));
  await page.evaluate(() => window.burstcam.camera.setZoom(2, { save: false }));
  await expect.poll(async () => (await exposure(page)).time, { timeout: 15_000 }).toBeLessThanOrEqual(167);
});

test('на свету защита не вмешивается', async ({ page }) => {
  test.skip(!!q(), 'достаточно одного прогона');
  await openApp(page, fake());
  await page.waitForFunction(() => window.burstcam.camera.guard, null, { timeout: 15_000 });
  await page.waitForTimeout(2500);
  expect(await exposure(page)).toMatchObject({ mode: 'continuous', guard: 'auto' });
});

test('ISO не действует — защита отключается и возвращает автоматику', async ({ page }) => {
  test.skip(!!q(), 'достаточно одного прогона');
  await openApp(page, fake('dark=1&isoIgnored=1'));
  await expect.poll(() => exposure(page), { timeout: 20_000 }).toMatchObject({ mode: 'continuous', guard: 'off' });
});

test('выключатель в настройках возвращает автоматику и запоминается', async ({ page }) => {
  test.skip(!!q(), 'достаточно одного прогона');
  await openApp(page, fake('dark=1'));
  await expect.poll(() => exposure(page), { timeout: 15_000 }).toMatchObject({ mode: 'manual' });
  await page.locator('#settings').click();
  await page.locator('.opt[data-group="antiblur"][data-value="off"]').click();
  await expect.poll(() => exposure(page)).toMatchObject({ mode: 'continuous' });
  await page.reload();
  await page.waitForFunction(() => window.burstcam?.camera?.source);
  expect(await page.evaluate(() => window.burstcam.camera.prefs.antiblur)).toBe(false);
});

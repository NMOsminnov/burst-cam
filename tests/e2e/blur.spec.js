// Смаз после нажатия (жалоба автора 17.11: «нажал на кнопку, а потом фото смазалось»).
// Причина по журналу: родной снимок (takePhoto) начинался при ОТПУСКАНИИ кнопки и приходил
// ещё через ~0,85 с, а вспышка мигала сразу при нажатии — человек опускал телефон раньше кадра.
import { test, expect } from '@playwright/test';
import { q, url, openApp, count, waitReady, clearDb } from './helpers.js';

const fake = (more = '') => [q() ? '' : 'fake=1920x1080', more].filter(Boolean).join('&');

test.beforeEach(async ({ page }) => { await clearDb(page); });

const source = (page) => page.evaluate(() => window.burstcam.library.photos[0].source);

test('«Авто»: если родное фото не крупнее кадра потока — мгновенный кадр, без takePhoto', async ({ page }) => {
  // Как на телефоне автора: и поток, и родное фото — одного размера.
  await openApp(page, fake('still=1920x1080'));
  await page.waitForFunction(() => window.burstcam.camera.stillCaps, null, { timeout: 10_000 });
  await page.waitForTimeout(300);
  const box = await page.locator('#shutter').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up();
  await waitReady(page);
  expect(await count(page)).toBe(1);
  expect(await source(page)).toBe('frame');
  expect(await page.evaluate(() => window.__fakeStats.takePhoto)).toBe(0);
});

test('«Авто»: родное фото заметно крупнее — снимается родное', async ({ page }) => {
  await openApp(page, fake('still=4000x3000'));
  await page.waitForFunction(() => window.burstcam.camera.still, null, { timeout: 10_000 });
  expect(await page.evaluate(() => window.burstcam.camera.prefs.tapMode)).toBe('auto');
  const box = await page.locator('#shutter').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up();
  await waitReady(page);
  expect(await source(page)).toBe('still');
});

test('родной снимок начинается при нажатии, «щёлк» — когда снят, а не при касании', async ({ page }) => {
  await openApp(page, fake('still=4000x3000'));
  await page.waitForFunction(() => window.burstcam.camera.still, null, { timeout: 10_000 });
  await page.evaluate(() => {
    window.__flashes = [];
    const f = document.getElementById('flash');
    new MutationObserver(() => { if (f.classList.contains('go')) window.__flashes.push(performance.now()); }).observe(f, { attributes: true });
  });
  const box = await page.locator('#shutter').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150); // меньше порога серии (260 мс)
  const atHold = await page.evaluate(() => ({
    takes: window.__fakeStats.takePhoto,
    capturing: document.getElementById('shutter').classList.contains('capturing'),
    flashes: window.__flashes.length,
  }));
  await page.mouse.up();
  expect(atHold.takes, 'takePhoto должен стартовать ещё до отпускания').toBe(1);
  expect(atHold.capturing, 'кнопка показывает «держите»').toBe(true);
  expect(atHold.flashes, 'вспышки до готового снимка быть не должно').toBe(0);
  await waitReady(page);
  expect(await page.evaluate(() => window.__flashes.length)).toBeGreaterThan(0);
  await expect(page.locator('#shutter')).not.toHaveClass(/capturing/);
  expect(await source(page)).toBe('still');
});

test('старая настройка «родной снимок» (по умолчанию v1) переводится на «Авто»', async ({ page }) => {
  await page.goto(url(fake('still=1920x1080')));
  await page.evaluate(() => localStorage.setItem('burstcam.settings.v1', JSON.stringify({ tapMode: 'native', quality: 'max' })));
  await openApp(page, fake('still=1920x1080'));
  const p = await page.evaluate(() => window.burstcam.camera.prefs);
  expect(p.tapMode).toBe('auto');
  expect(p.quality).toBe('max');
});

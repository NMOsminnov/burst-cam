// Сквозная проверка: съёмка (касание и удержание), галерея, серия, просмотр, удаление.
import { test, expect } from '@playwright/test';
import { q, openApp, count, waitIdle, waitReady, shutter, clearDb } from './helpers.js';

test.beforeEach(async ({ page }) => { await clearDb(page); });

test('касание — ровно одно фото, JPEG в разрешении потока', async ({ page }) => {
  const errors = await openApp(page);
  const info = await page.evaluate(() => window.burstcam.info());
  test.info().annotations.push({ type: 'камера', description: JSON.stringify(info) });

  await shutter(page, 60);
  await expect.poll(() => count(page), { timeout: 15_000 }).toBe(1);
  await waitIdle(page);

  const photo = await page.evaluate(async () => {
    const m = window.burstcam.library.photos[0];
    const { getBlob } = await import('./js/core/store.js');
    const blob = await getBlob(m.id);
    const bmp = await createImageBitmap(blob);
    const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
    return { type: blob.type, w: bmp.width, h: bmp.height, meta: { w: m.width, h: m.height, idx: m.idx }, head: [...head], thumb: m.thumb.size };
  });
  expect(photo.type).toBe('image/jpeg');
  expect(photo.head).toEqual([0xff, 0xd8, 0xff]);
  expect(photo.w).toBe(info.width);
  expect(photo.h).toBe(info.height);
  expect(photo.meta.idx).toBe(0);
  expect(photo.thumb).toBeGreaterThan(500);
  await expect(page.locator('#last-thumb')).toBeVisible();
  expect(errors).toEqual([]);
});

test('удержание — серия, одна плитка в галерее, просмотр, удаление кадра и всей серии', async ({ page }) => {
  const errors = await openApp(page);
  await shutter(page, 1600);
  await waitIdle(page);
  const n = await count(page);
  test.info().annotations.push({ type: 'кадров за 1,6 с', description: String(n) });
  expect(n).toBeGreaterThanOrEqual(8);

  const series = await page.evaluate(() => {
    const ps = window.burstcam.library.photos;
    return { ids: new Set(ps.map((p) => p.seriesId)).size, idx: ps.map((p) => p.idx).sort((a, b) => a - b) };
  });
  expect(series.ids).toBe(1);
  expect(series.idx).toEqual([...Array(n).keys()]);

  // Галерея: одна плитка со счётчиком.
  await page.locator('#to-gallery').click();
  const tiles = page.locator('#gallery .tile');
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first().locator('.badge')).toContainText(String(n));

  // Серия → кадры.
  await tiles.first().click();
  await expect(page.locator('#series .tile')).toHaveCount(n);
  await expect(page.locator('#series [data-ref="title"]')).toContainText(`${n} фото`);
  // Плитки — квадраты и не наезжают друг на друга (была ошибка: строки сжимались в длинной серии).
  const rects = await page.locator('#series .tile').evaluateAll((ts) => ts.slice(0, 7).map((t) => t.getBoundingClientRect()).map((r) => ({ y: r.y, h: r.height, w: r.width })));
  for (const r of rects) expect(Math.abs(r.h - r.w)).toBeLessThan(1.5);
  expect(rects[3].y).toBeGreaterThanOrEqual(rects[0].y + rects[0].h);

  // Просмотр второго кадра, листание, удаление.
  await page.locator('#series .tile').nth(1).click();
  await expect(page.locator('#viewer')).toBeVisible();
  await expect(page.locator('#viewer [data-ref="pos"]')).toHaveText(`2 из ${n}`);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#viewer [data-ref="pos"]')).toHaveText(`3 из ${n}`);
  await page.locator('#viewer [data-act="delete"]').click();
  await page.locator('#confirm-ok').click();
  await expect.poll(() => count(page)).toBe(n - 1);
  await expect(page.locator('#viewer [data-ref="pos"]')).toHaveText(`3 из ${n - 1}`);

  // Назад в серию → выбрать все → удалить.
  await page.locator('#viewer [data-act="back"]').click();
  await expect(page.locator('#viewer')).toBeHidden();
  await page.locator('#series [data-act="select"]').click();
  await page.locator('#series [data-act="all"]').click();
  await page.locator('#series [data-act="delete"]').click();
  await expect(page.locator('#confirm-text')).toContainText('всю серию');
  await page.locator('#confirm-ok').click();
  await expect.poll(() => count(page)).toBe(0);
  await expect(page.locator('#series')).toBeHidden();
  await expect(page.locator('#gallery [data-ref="empty"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('касания одно за другим: каждое — отдельное фото, без подтверждений', async ({ page }) => {
  await openApp(page);
  for (let i = 0; i < 5; i++) { await shutter(page, 40); await waitReady(page); }
  await waitIdle(page);
  await expect.poll(() => count(page), { timeout: 15_000 }).toBe(5);
  const seriesCount = await page.evaluate(() => new Set(window.burstcam.library.photos.map((p) => p.seriesId)).size);
  expect(seriesCount).toBe(5);
});

test('фото переживают перезагрузку; свайп в просмотре листает', async ({ page }) => {
  await openApp(page);
  await shutter(page, 40);
  await waitReady(page);
  await shutter(page, 40);
  await waitIdle(page);
  await expect.poll(() => count(page)).toBe(2);
  await page.reload();
  await expect(page.locator('#shutter')).toBeEnabled({ timeout: 20_000 });
  await page.waitForFunction(() => window.burstcam);
  await expect.poll(() => count(page)).toBe(2);

  await page.locator('#to-gallery').click();
  await page.locator('#gallery .tile').first().click();
  await expect(page.locator('#viewer [data-ref="pos"]')).toHaveText('1 из 2');
  const vp = page.viewportSize();
  await page.mouse.move(vp.width * 0.8, vp.height / 2);
  await page.mouse.down();
  await page.mouse.move(vp.width * 0.4, vp.height / 2, { steps: 6 });
  await page.mouse.move(vp.width * 0.1, vp.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('#viewer [data-ref="pos"]')).toHaveText('2 из 2');
  // Системная «назад» закрывает просмотр, затем галерею.
  await page.goBack();
  await expect(page.locator('#viewer')).toBeHidden();
  await page.goBack();
  await expect(page.locator('#gallery')).toBeHidden();
});

test('страница диагностики проходит замер без ошибок', async ({ page }) => {
  test.skip(!!q(), 'достаточно одного прогона');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/diag.html');
  await expect(page.locator('#caps tr').first()).toBeVisible();
  await page.locator('#run').click();
  await expect(page.locator('#run')).toBeEnabled({ timeout: 45_000 });
  const rep = JSON.parse(await page.locator('#dump').textContent());
  test.info().annotations.push({ type: 'замер', description: JSON.stringify(rep.camera) });
  expect(rep.camera.error).toBeUndefined();
  expect(rep.camera.jpegWorkerMs).toBeGreaterThan(0);
  await page.locator('#lenses').click();
  await expect(page.locator('#lenses')).toBeEnabled({ timeout: 45_000 });
  const rep2 = JSON.parse(await page.locator('#dump').textContent());
  expect(rep2.lenses.length).toBeGreaterThan(0);
  expect(rep2.lenses.every((l) => !l.error && l.modes)).toBe(true);
  expect(errors).toEqual([]);
});

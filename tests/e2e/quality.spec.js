// Качество и режимы: родной снимок по касанию, блокировка кнопки до сохранения,
// объективы (ультраширик), режимы камеры, качество JPEG.
import { test, expect } from '@playwright/test';
import { q, openApp, count, waitIdle, waitReady, shutter, clearDb } from './helpers.js';

const fake = (more = '') => [q() ? '' : 'fake=1920x1080', more].filter(Boolean).join('&');

test.beforeEach(async ({ page }) => { await clearDb(page); });

/** Прочитать сохранённое фото: размер, тип, цвет левого верхнего угла (жёлтый в подделке). */
async function readPhoto(page, i = 0) {
  return page.evaluate(async (i) => {
    const m = window.burstcam.library.photos[i];
    const { getBlob } = await import('./js/core/store.js');
    const blob = await getBlob(m.id);
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const x = c.getContext('2d');
    x.drawImage(bmp, 0, 0);
    const px = (fx, fy) => [...x.getImageData(Math.floor(bmp.width * fx), Math.floor(bmp.height * fy), 1, 1).data].slice(0, 3);
    return { w: bmp.width, h: bmp.height, type: blob.type, bytes: blob.size, source: m.source, topLeft: px(0.05, 0.05), bottomRight: px(0.95, 0.6) };
  }, i);
}

const yellow = ([r, g, b]) => r > 200 && g > 160 && b < 120;

test('касание — родной снимок полного разрешения, повёрнутый «сенсор» выправлен, без пересжатия', async ({ page }) => {
  const errors = await openApp(page, fake('still=4000x3000&stillRot=90'));
  await page.waitForFunction(() => window.burstcam.camera.still, null, { timeout: 10_000 });
  await expect(page.locator('#res-label')).toContainText('Фото 12 Мп');

  await shutter(page, 40);
  await waitReady(page);
  expect(await count(page)).toBe(1);
  const p = await readPhoto(page);
  expect(p.source).toBe('still');
  expect([p.w, p.h]).toEqual([4000, 3000]);
  expect(yellow(p.topLeft), `левый верхний угол должен быть жёлтым: ${p.topLeft}`).toBe(true);
  expect(yellow(p.bottomRight)).toBe(false);
  expect(errors).toEqual([]);
});

test('пока прошлое фото не сохранено, кнопка не снимает (и не роняет родной снимок)', async ({ page }) => {
  await openApp(page, fake('still=4000x3000'));
  await page.waitForFunction(() => window.burstcam.camera.still, null, { timeout: 10_000 });
  // Три касания подряд, не дожидаясь обработки: снимок должен быть ровно один.
  for (let i = 0; i < 3; i++) await shutter(page, 30);
  await expect(page.locator('#shutter')).toHaveClass(/busy/);
  await waitReady(page);
  expect(await count(page)).toBe(1);
  const stats = await page.evaluate(() => window.__fakeStats);
  expect(stats.rejected, 'takePhoto не должен вызываться внахлёст').toBe(0);
  expect((await readPhoto(page)).source).toBe('still');
  // После сохранения — снова снимает.
  await shutter(page, 30);
  await waitReady(page);
  expect(await count(page)).toBe(2);
});

test('настройки: выбор «кадр потока» вместо родного снимка', async ({ page }) => {
  await openApp(page, fake('still=4000x3000'));
  await page.waitForFunction(() => window.burstcam.camera.still);
  await page.locator('#settings').click();
  await page.locator('.opt', { hasText: 'Кадр видеопотока' }).click();
  await page.locator('#settings-sheet [data-act="close"]').click();
  await shutter(page, 30);
  await waitReady(page);
  const p = await readPhoto(page);
  expect(p.source).toBe('frame');
  expect(p.w).toBe(await page.evaluate(() => window.burstcam.camera.settings.width));
  // Выбор сохраняется.
  await page.reload();
  await page.waitForFunction(() => window.burstcam?.camera?.source);
  expect(await page.evaluate(() => window.burstcam.camera.prefs.tapMode)).toBe('stream');
});

test('объективы: ультраширик из списка камер, кнопка 0,5× и обратно 1×', async ({ page }) => {
  test.skip(!q(), 'нужна поддельная камера с несколькими объективами');
  await openApp(page);
  // Подсказка на месте и не мешает нажать «0,5×» (была ошибка: перехватывала касание).
  await expect(page.locator('#hint')).toBeVisible();
  await expect(page.locator('#zoom-bar .lens-switch')).toHaveText('0,5×');
  await page.locator('#zoom-bar .lens-switch').click();
  await expect.poll(() => page.evaluate(() => window.burstcam.camera.settings.deviceId)).toBe('fake-ultra');
  await expect(page.locator('#zoom-bar .lens-switch')).toHaveText('1×');
  await expect(page.locator('#lens')).toHaveText('0,5×');
  // Снимок с ультраширика.
  await shutter(page, 30);
  await waitReady(page);
  expect(await count(page)).toBe(1);
  // Через лист настроек — обратно на основную.
  await page.locator('#settings').click();
  await expect(page.locator('#settings-sheet .chip')).toHaveText(['Основная', 'Ультраширокая', 'Фронтальная']);
  await page.locator('#settings-sheet .chip', { hasText: 'Основная' }).click();
  await expect.poll(() => page.evaluate(() => window.burstcam.camera.settings.deviceId)).toBe('fake-back');
});

test('режимы камеры: опрос показывает реальные режимы, выбранный сохраняется', async ({ page }) => {
  test.skip(!q(), 'режимы задаёт поддельная камера');
  await openApp(page);
  await page.locator('#settings').click();
  await page.locator('[data-act="probe"]').click();
  const opts = page.locator('#settings-sheet .opt[data-group="mode"]');
  await expect(opts.first()).toBeVisible({ timeout: 15_000 });
  await expect(opts).toHaveText([/Автоматически/, /3840×2160/, /2560×1440/, /1920×1080/, /1280×720/]);
  await page.locator('#settings-sheet .opt[data-value="3840x2160"]').click();
  await expect.poll(() => page.evaluate(() => window.burstcam.camera.settings.width), { timeout: 15_000 }).toBe(3840);
  await page.reload();
  await page.waitForFunction(() => window.burstcam?.camera?.source);
  expect(await page.evaluate(() => window.burstcam.camera.settings.width)).toBe(3840);
});

test('качество JPEG: «максимальное» заметно крупнее «компактного»', async ({ page }) => {
  test.skip(!q(), 'достаточно одного прогона');
  await openApp(page);
  // Фиксированный режим: иначе автоподбор может сменить разрешение между снимками.
  await page.evaluate(() => window.burstcam.camera.setStreamMode([1920, 1080]));
  await page.waitForFunction(() => window.burstcam.camera.source && window.burstcam.camera.settings.width === 1920);
  const shoot = async (label) => {
    await page.locator('#settings').click();
    await page.locator('.opt[data-group="quality"]', { hasText: label }).click();
    await page.locator('#settings-sheet [data-act="close"]').click();
    await shutter(page, 30);
    await waitReady(page);
    return (await readPhoto(page, 0)).bytes;
  };
  const compact = await shoot('Компактное');
  const max = await shoot('Максимальное');
  test.info().annotations.push({ type: 'размер 1080p', description: `компактное ${compact} Б, максимальное ${max} Б` });
  expect(max).toBeGreaterThan(compact * 1.5);
});

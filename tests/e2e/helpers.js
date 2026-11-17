// Общее для сквозных тестов.
import { test, expect } from '@playwright/test';

export const q = () => test.info().project.metadata.query || '';

export function url(extra = '') {
  const base = q();
  const parts = [base.replace(/^\?/, ''), extra, 'nosw'].filter(Boolean);
  return '/?' + parts.join('&');
}

export async function openApp(page, extra = '') {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url(extra));
  await expect(page.locator('#shutter')).toBeEnabled({ timeout: 20_000 });
  await page.waitForFunction(() => window.burstcam?.camera?.source);
  return errors;
}

export const count = (page) => page.evaluate(() => window.burstcam.library.photos.length);
export const waitIdle = (page) => page.waitForFunction(() => document.getElementById('pending').hidden, null, { timeout: 30_000 });
/** Кнопка снова готова снимать (прошлое фото сохранено). */
export const waitReady = (page) => page.waitForFunction(() => !document.getElementById('shutter').classList.contains('busy') && document.getElementById('pending').hidden, null, { timeout: 30_000 });

export async function shutter(page, holdMs) {
  const box = await page.locator('#shutter').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  await page.mouse.up();
}

export async function clearDb(page) {
  await page.goto(url());
  await page.evaluate(() => new Promise((r) => { const req = indexedDB.deleteDatabase('burstcam'); req.onsuccess = req.onerror = req.onblocked = () => r(); }));
}

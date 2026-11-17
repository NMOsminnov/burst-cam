// Журнал с телефона сам приходит на сервер ноутбука (logs/<дата>.jsonl).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { q, openApp, shutter, waitReady, clearDb } from './helpers.js';

const LOG_DIR = path.resolve('artifacts/e2e-logs');
const readLog = () => {
  const f = path.join(LOG_DIR, new Date().toISOString().slice(0, 10) + '.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

test('журнал: запуск, камера, снимок и ошибки доходят до сервера', async ({ page }) => {
  test.skip(!!q(), 'достаточно одного прогона');
  await clearDb(page);
  await openApp(page);
  await shutter(page, 30);
  await waitReady(page);
  await page.evaluate(() => console.error('проверка журнала', 42));
  await expect.poll(() => {
    const mine = readLog();
    const kinds = new Set(mine.map((e) => e.kind));
    return ['start', 'camera:ready', 'saved', 'console'].every((k) => kinds.has(k));
  }, { timeout: 15_000 }).toBe(true);
  const all = readLog();
  const err = all.find((e) => e.kind === 'console' && String(e.data?.msg).includes('проверка журнала'));
  expect(err.level).toBe('error');
  const ready = all.filter((e) => e.kind === 'camera:ready').pop();
  expect(ready.data.width).toBeGreaterThan(0);
  expect(ready.ip).toBeTruthy();
});

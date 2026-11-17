// Сквозные тесты: настоящий сервер, безголовый Chromium с поддельной камерой.
// Окна браузера не показываются.
import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Если браузер нужной версии не скачан, берём любой уже установленный Chromium Playwright. */
function chromiumPath() {
  if (process.env.BURSTCAM_CHROMIUM) return process.env.BURSTCAM_CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (!fs.existsSync(base)) return undefined;
  const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const p = path.join(base, d, exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

const PORT = 18443;
const exe = chromiumPath();

const chromeArgs = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
];

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "artifacts/e2e-report.json" }]],
  outputDir: 'artifacts/test-results',
  use: {
    baseURL: `https://localhost:${PORT}/`,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    headless: true,
  },
  webServer: {
    command: `node server/serve.js --port ${PORT} --http 18080 --quiet --logs artifacts/e2e-logs`,
    url: 'http://127.0.0.1:18080/health',
    reuseExistingServer: false,
    timeout: 20_000,
  },
  projects: [
    {
      name: 'android-модуль (Chromium, MediaStreamTrackProcessor в воркере)',
      use: {
        ...devices['Pixel 7'],
        launchOptions: { args: chromeArgs, executablePath: exe },
        permissions: ['camera'],
      },
      metadata: { query: '' },
    },
    {
      name: 'ios-модуль (запасной путь: кадры из <video>)',
      use: {
        ...devices['Pixel 7'],
        launchOptions: { args: chromeArgs, executablePath: exe },
        permissions: ['camera'],
      },
      metadata: { query: '?engine=ios&fake=1920x1080' },
    },
  ],
});

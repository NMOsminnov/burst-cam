// Сервер не падает, если порт занят другой программой (на Windows 8080 часто держит svchost),
// а берёт следующий свободный. На старом коде здесь был выход с ошибкой.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVE = fileURLToPath(new URL('../../server/serve.js', import.meta.url));

test('занятый порт — сервер берёт следующий и отвечает на нём', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '0.0.0.0', r));
  const busy = blocker.address().port;
  const child = fork(SERVE, ['--port', '0', '--http', String(busy), '--quiet'], { stdio: 'pipe' });
  try {
    const ready = await new Promise((resolve, reject) => {
      child.on('message', resolve);
      child.on('exit', (code) => reject(new Error('сервер завершился с кодом ' + code)));
      setTimeout(() => reject(new Error('сервер не стартовал')), 15000);
    });
    assert.notEqual(ready.httpPort, busy);
    assert.ok(ready.httpPort > busy && ready.httpPort < busy + 20);
    const res = await fetch(`http://127.0.0.1:${ready.httpPort}/health`);
    assert.equal(await res.text(), 'ok');
  } finally {
    child.kill();
    blocker.close();
  }
});

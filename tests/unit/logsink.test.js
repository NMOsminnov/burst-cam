import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogSink } from '../../server/logsink.js';

test('приём журнала: пишет JSONL с IP и сессией, отвергает мусор и огромное', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burstcam-log-'));
  const echoed = [];
  const sink = createLogSink({ dir, echo: (s) => echoed.push(s) });
  const srv = http.createServer((req, res) => { if (!sink(req, res)) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/api/log`;
  try {
    let r = await fetch(base, { method: 'POST', body: JSON.stringify({ session: 's1', page: 'app', entries: [{ kind: 'start', level: 'info' }, { kind: 'console', level: 'error', data: { msg: 'упало' } }] }) });
    assert.equal(r.status, 204);
    r = await fetch(base, { method: 'POST', body: '{не json' });
    assert.equal(r.status, 400);
    r = await fetch(base, { method: 'POST', body: 'x'.repeat(600 * 1024) }).catch(() => ({ status: 413 }));
    assert.equal(r.status, 413);
    await new Promise((res) => setTimeout(res, 100));
    const lines = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].session, 's1');
    assert.equal(lines[0].ip, '127.0.0.1');
    assert.equal(echoed.length, 1, 'ошибки дублируются в окно сервера');
  } finally {
    srv.close();
  }
});

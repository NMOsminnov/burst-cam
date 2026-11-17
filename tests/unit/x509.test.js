// Сертификаты: Node/OpenSSL должны принимать цепочку, а ограничение имён — реально работать.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import { createCA, createServerCert, isPermittedIPv4 } from '../../server/x509.js';

const ca = createCA();

test('CA разбирается и подписан сам собой, это CA', () => {
  const c = new crypto.X509Certificate(ca.certPem);
  assert.equal(c.ca, true);
  assert.ok(c.verify(c.publicKey));
  assert.match(c.subject, /BurstCam Local CA/);
  assert.ok(new Date(c.validTo) > new Date(Date.now() + 9 * 365 * 24 * 3600e3));
});

test('сертификат сервера подписан CA и покрывает IP', () => {
  const leaf = createServerCert({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, ips: ['127.0.0.1', '192.168.137.1', '172.20.10.2'] });
  const c = new crypto.X509Certificate(leaf.certPem);
  assert.ok(c.verify(new crypto.X509Certificate(ca.certPem).publicKey));
  assert.equal(c.checkIP('192.168.137.1'), '192.168.137.1');
  assert.equal(c.checkIP('172.20.10.2'), '172.20.10.2');
  assert.equal(c.checkHost('localhost'), 'localhost');
  assert.equal(c.ca, false);
  assert.ok(c.checkIssued(new crypto.X509Certificate(ca.certPem)));
});

async function handshake(leaf, servername) {
  const server = https.createServer({ cert: leaf.certPem + ca.certPem, key: leaf.keyPem }, (_, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await new Promise((resolve) => {
      const sock = tls.connect({ host: '127.0.0.1', port, ca: ca.certPem, servername }, () => {
        resolve({ ok: sock.authorized, err: sock.authorizationError });
        sock.end();
      });
      sock.on('error', (e) => resolve({ ok: false, err: e.code || e.message }));
    });
  } finally {
    server.close();
  }
}

test('TLS-рукопожатие с доверием только к нашему CA проходит', async () => {
  const leaf = createServerCert({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, ips: ['127.0.0.1'] });
  const r = await handshake(leaf);
  assert.equal(r.ok, true, String(r.err));
});

test('ограничение имён: сертификат на чужой домен отвергается даже при доверии к CA', async () => {
  const evil = createServerCert({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, ips: ['127.0.0.1'], dns: ['bank.example.com'] });
  const r = await handshake(evil, 'bank.example.com');
  assert.equal(r.ok, false);
  // OpenSSL: «error 47: permitted subtree violation»; Node не знает этот код и пишет UNSPECIFIED.
  assert.match(String(r.err), /NAME_CONSTRAINTS|permitted|constraint|UNSPECIFIED/i);
});

test('ограничение имён: публичный IP отвергается', async () => {
  const evil = createServerCert({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, ips: ['127.0.0.1', '8.8.8.8'] });
  const r = await handshake(evil);
  assert.equal(r.ok, false);
});

test('частные диапазоны', () => {
  for (const ip of ['192.168.137.1', '172.20.10.3', '10.1.2.3', '100.100.1.1']) assert.ok(isPermittedIPv4(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1']) assert.ok(!isPermittedIPv4(ip), ip);
});

// Хранение CA и выпуск сертификата сервера под текущие адреса.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCA, createServerCert, isPermittedIPv4 } from './x509.js';

export function certDir(root) {
  return path.join(root, '.certs');
}

/** Загрузить CA с диска или создать новый (один раз; потом его ставят на телефон). */
export function loadOrCreateCA(root) {
  const dir = certDir(root);
  const certPath = path.join(dir, 'ca.pem');
  const keyPath = path.join(dir, 'ca.key');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const certPem = fs.readFileSync(certPath, 'utf8');
    const cert = new crypto.X509Certificate(certPem);
    if (new Date(cert.validTo) > new Date(Date.now() + 30 * 24 * 3600e3)) {
      return { certPem, keyPem: fs.readFileSync(keyPath, 'utf8'), created: false, cert };
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  const ca = createCA();
  fs.writeFileSync(certPath, ca.certPem);
  fs.writeFileSync(path.join(dir, 'ca.crt'), ca.certDer); // DER — так телефоны ставят без вопросов
  fs.writeFileSync(keyPath, ca.keyPem, { mode: 0o600 });
  return { certPem: ca.certPem, keyPem: ca.keyPem, created: true, cert: new crypto.X509Certificate(ca.certPem) };
}

export function caDer(root) {
  const p = path.join(certDir(root), 'ca.crt');
  return fs.readFileSync(p);
}

/** Сертификат сервера под адреса; адреса вне разрешённых CA диапазонов отбрасываются. */
export function issueServerCert(ca, ips) {
  const usable = ips.filter((ip) => isPermittedIPv4(ip));
  return {
    ...createServerCert({
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
      ips: ['127.0.0.1', ...usable.filter((ip) => ip !== '127.0.0.1')],
      dns: ['localhost'],
    }),
    ips: usable,
  };
}

export function fingerprint(certPem) {
  return new crypto.X509Certificate(certPem).fingerprint256;
}

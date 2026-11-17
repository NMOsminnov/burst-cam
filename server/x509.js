// Минимальный сборщик сертификатов X.509 на чистом Node (без openssl и без зависимостей).
//
// Зачем свой: камера в браузере работает только на «безопасном» (HTTPS) адресе, а у ноутбука
// в точке доступа нет доменного имени — только IP. Поэтому заводим свой маленький
// удостоверяющий центр (CA), ставим его на телефон один раз, а сертификат сервера
// перевыпускаем при каждом запуске под текущие IP-адреса.
//
// Безопасность: в CA зашито ограничение имён (nameConstraints) — он может подписывать
// ТОЛЬКО частные адреса (10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16, 127/8) и имена
// localhost / *.local. Даже если ключ CA украдут, им нельзя подделать сайт банка или почты:
// телефон отвергнет такой сертификат.

import crypto from 'node:crypto';

// ---------- DER-кодирование ----------

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag, ...parts) {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
}

const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const octet = (b) => tlv(0x04, b);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const explicit = (n, inner) => tlv(0xa0 + n, inner);

function integer(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && (b[1] & 0x80) === 0) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function bitString(bytes, unusedBits = 0) {
  return tlv(0x03, Buffer.from([unusedBits]), bytes);
}

export function oid(str) {
  const parts = str.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    let v = p >>> 7;
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v >>>= 7; }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(date) {
  const y = date.getUTCFullYear();
  const pad = (n) => String(n).padStart(2, '0');
  const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  // RFC 5280: до 2049 года — UTCTime, дальше — GeneralizedTime.
  if (y < 2050) return tlv(0x17, Buffer.from(`${String(y).slice(2)}${rest}`, 'ascii'));
  return tlv(0x18, Buffer.from(`${y}${rest}`, 'ascii'));
}

// ---------- Части сертификата ----------

const OID = {
  ecdsaSha256: '1.2.840.10045.4.3.2',
  cn: '2.5.4.3',
  o: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  subjectKeyId: '2.5.29.14',
  authorityKeyId: '2.5.29.35',
  nameConstraints: '2.5.29.30',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

const sigAlg = () => seq(oid(OID.ecdsaSha256));

function name({ cn, o }) {
  const rdns = [];
  if (o) rdns.push(set(seq(oid(OID.o), utf8(o))));
  rdns.push(set(seq(oid(OID.cn), utf8(cn))));
  return seq(...rdns);
}

function ext(id, critical, valueDer) {
  return critical ? seq(oid(id), bool(true), octet(valueDer)) : seq(oid(id), octet(valueDer));
}

function ipBytes(ip) {
  if (ip.includes(':')) {
    // IPv6: разворачиваем «::».
    const [head, tail = ''] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
    const b = Buffer.alloc(16);
    groups.forEach((g, i) => b.writeUInt16BE(parseInt(g || '0', 16), i * 2));
    return b;
  }
  return Buffer.from(ip.split('.').map(Number));
}

/** Частные диапазоны, которые разрешено подписывать нашему CA. */
export const PERMITTED_V4 = [
  ['10.0.0.0', '255.0.0.0'],
  ['172.16.0.0', '255.240.0.0'],
  ['192.168.0.0', '255.255.0.0'],
  ['100.64.0.0', '255.192.0.0'], // CGNAT / Tailscale
  ['169.254.0.0', '255.255.0.0'], // link-local
  ['127.0.0.0', '255.0.0.0'],
];
export const PERMITTED_DNS = ['localhost', 'local'];

function spkiDer(publicKey) {
  return publicKey.export({ type: 'spki', format: 'der' });
}

function keyId(publicKey) {
  return crypto.createHash('sha1').update(spkiDer(publicKey)).digest();
}

function sign(tbs, privateKey) {
  const sig = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  return seq(tbs, sigAlg(), bitString(sig));
}

function toPem(der) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

function serial() {
  const b = crypto.randomBytes(16);
  b[0] &= 0x7f; // положительное число
  if (b[0] === 0) b[0] = 1;
  return integer(b);
}

function newKey() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

/** Выпустить корневой CA с ограничением имён. */
export function createCA({ cn = 'BurstCam Local CA', years = 10, now = new Date() } = {}) {
  const { publicKey, privateKey } = newKey();
  const notBefore = new Date(now.getTime() - 24 * 3600e3);
  const notAfter = new Date(now.getTime() + years * 365 * 24 * 3600e3);
  const subject = name({ cn, o: 'BurstCam (только локальная сеть)' });

  const permitted = [
    ...PERMITTED_V4.map(([a, m]) => seq(tlv(0x87, Buffer.concat([ipBytes(a), ipBytes(m)])))),
    ...PERMITTED_DNS.map((d) => seq(tlv(0x82, Buffer.from(d, 'ascii')))),
  ];

  const extensions = seq(
    ext(OID.basicConstraints, true, seq(bool(true), integer(Buffer.from([0])))),
    // digitalSignature | keyCertSign | cRLSign
    ext(OID.keyUsage, true, bitString(Buffer.from([0x86]), 1)),
    ext(OID.subjectKeyId, false, octet(keyId(publicKey))),
    ext(OID.nameConstraints, true, seq(tlv(0xa0, ...permitted))),
  );

  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    serial(),
    sigAlg(),
    subject,
    seq(time(notBefore), time(notAfter)),
    subject,
    spkiDer(publicKey),
    explicit(3, extensions),
  );
  const der = sign(tbs, privateKey);
  return {
    certPem: toPem(der),
    certDer: der,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

/** Выпустить сертификат сервера под заданные IP и имена, подписанный CA. */
export function createServerCert({ caCertPem, caKeyPem, ips = [], dns = ['localhost'], days = 30, now = new Date() }) {
  const caKey = crypto.createPrivateKey(caKeyPem);
  const caCert = new crypto.X509Certificate(caCertPem);
  const caPub = caCert.publicKey;
  const { publicKey, privateKey } = newKey();
  const notBefore = new Date(now.getTime() - 24 * 3600e3);
  const notAfter = new Date(now.getTime() + days * 24 * 3600e3);

  const san = seq(
    ...dns.map((d) => tlv(0x82, Buffer.from(d, 'ascii'))),
    ...ips.map((ip) => tlv(0x87, ipBytes(ip))),
  );

  const extensions = seq(
    ext(OID.basicConstraints, true, seq()),
    ext(OID.keyUsage, true, bitString(Buffer.from([0x80]), 7)), // digitalSignature
    ext(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
    ext(OID.subjectAltName, false, san),
    ext(OID.subjectKeyId, false, octet(keyId(publicKey))),
    ext(OID.authorityKeyId, false, seq(tlv(0x80, keyId(caPub)))),
  );

  // Издатель — ровно тот Name, что записан в CA (берём байты из самого сертификата CA).
  const issuer = extractSubjectDer(caCert.raw);

  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    serial(),
    sigAlg(),
    issuer,
    seq(time(notBefore), time(notAfter)),
    name({ cn: ips[0] || dns[0] || 'localhost', o: 'BurstCam' }),
    spkiDer(publicKey),
    explicit(3, extensions),
  );
  const der = sign(tbs, caKey);
  return {
    certPem: toPem(der),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

// ---------- Разбор DER (только чтобы достать subject из CA) ----------

function readTlv(buf, off) {
  const tag = buf[off];
  let l = buf[off + 1];
  let hdr = 2;
  if (l & 0x80) {
    const n = l & 0x7f;
    l = 0;
    for (let i = 0; i < n; i++) l = (l << 8) | buf[off + 2 + i];
    hdr += n;
  }
  return { tag, start: off, bodyStart: off + hdr, end: off + hdr + l };
}

export function extractSubjectDer(certDer) {
  const cert = readTlv(certDer, 0);
  const tbs = readTlv(certDer, cert.bodyStart);
  let p = tbs.bodyStart;
  const fields = [];
  while (p < tbs.end) { const t = readTlv(certDer, p); fields.push(t); p = t.end; }
  // [0]version, serial, sigAlg, issuer, validity, subject
  const hasVersion = fields[0].tag === 0xa0;
  const subject = fields[hasVersion ? 5 : 4];
  return certDer.subarray(subject.start, subject.end);
}

/** Попадает ли адрес в разрешённые CA диапазоны (чтобы не выпускать заведомо отвергнутый сертификат). */
export function isPermittedIPv4(ip) {
  const n = (s) => s.split('.').reduce((a, x) => (a << 8) + Number(x), 0) >>> 0;
  return PERMITTED_V4.some(([a, m]) => ((n(ip) & n(m)) >>> 0) === ((n(a) & n(m)) >>> 0));
}

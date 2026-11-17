// Поддельная камера для автотестов и проверки на компьютере без телефона.
//   ?fake                 — поток 1920×1080
//   ?fake=3840x2160       — стартовый режим
//   &still=4000x3000      — поддельный ImageCapture.takePhoto() такого размера
//   &stillRot=90          — снимок повёрнут на 90° (как отдают часть Android-телефонов)
// Объективы: «Back Camera», «Back Ultra Wide Camera», «Front Camera» (ярлыки как в Safari).
// В рабочий кэш приложения (service worker) не попадает.

const LENSES = [
  { deviceId: 'fake-back', label: 'Back Camera', facing: 'environment', modes: [[3840, 2160], [2560, 1440], [1920, 1080], [1280, 720]], color: '#202830' },
  { deviceId: 'fake-ultra', label: 'Back Ultra Wide Camera', facing: 'environment', modes: [[2560, 1440], [1920, 1080], [1280, 720]], color: '#283020' },
  { deviceId: 'fake-front', label: 'Front Camera', facing: 'user', modes: [[1920, 1080], [1280, 720]], color: '#123' },
];

function closest(modes, w, h) {
  if (!w || !h) return modes.find((m) => m[0] * m[1] <= 1920 * 1080) || modes[modes.length - 1];
  const L = Math.max(w, h), S = Math.min(w, h);
  let best = modes[0], bd = Infinity;
  for (const m of modes) {
    const d = Math.abs(m[0] - L) / L + Math.abs(m[1] - S) / S;
    if (d < bd) { bd = d; best = m; }
  }
  return best;
}

const ideal = (c) => (c == null ? undefined : typeof c === 'number' ? c : c.ideal ?? c.exact ?? c.max);

export function installFakeCamera(spec, params = new URLSearchParams(location.search)) {
  const start = /^\d+x\d+$/.test(spec || '') ? spec.split('x').map(Number) : null;
  const stillSize = /^\d+x\d+$/.test(params.get('still') || '') ? params.get('still').split('x').map(Number) : null;
  const stillRot = Number(params.get('stillRot') || 0);
  const stillFail = params.has('stillFail');
  // stillDepends: при потоке 4K камера даёт фото 8 Мп, при 1080p — полный still (гипотеза по телефону автора).
  const stillDepends = params.has('stillDepends'); // getPhotoCapabilities отказывает (так бывает на части телефонов)
  window.__fakeStats = { takePhoto: 0, rejected: 0 };

  const makeStream = (constraints) => {
    const v = constraints?.video || {};
    const id = ideal(v.deviceId);
    const fm = ideal(v.facingMode) || 'environment';
    const lens = LENSES.find((l) => l.deviceId === id) || LENSES.find((l) => l.facing === fm) || LENSES[0];
    let [w, h] = start && lens === LENSES[0] ? start : closest(lens.modes, ideal(v.width), ideal(v.height));

    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    let n = 0;
    let stopped = false;
    const draw = () => {
      if (stopped) return;
      n++;
      const t = performance.now() / 1000;
      ctx.fillStyle = lens.color;
      ctx.fillRect(0, 0, c.width, c.height);
      // Несимметричная картинка — тесты проверяют по ней поворот: жёлтый угол слева сверху.
      ctx.fillStyle = '#ffd23f';
      ctx.fillRect(0, 0, c.width * 0.3, c.height * 0.3);
      ctx.fillStyle = '#4ac';
      ctx.fillRect(((t * 0.35) % 1) * c.width, c.height * 0.45, c.width * 0.08, c.height * 0.3);
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.round(c.height / 12)}px sans-serif`;
      ctx.fillText(`FAKE ${lens.label} ${c.width}x${c.height} #${n}`, c.width * 0.05, c.height * 0.9);
      setTimeout(draw, 1000 / 30);
    };
    draw();
    const stream = c.captureStream(30);
    const track = stream.getVideoTracks()[0];
    const origStop = track.stop.bind(track);
    track.stop = () => { stopped = true; origStop(); };
    const settings = () => ({ width: c.width, height: c.height, frameRate: 30, facingMode: lens.facing, deviceId: lens.deviceId, zoom: 1 });
    const caps = () => ({
      width: { min: 1, max: lens.modes[0][0] }, height: { min: 1, max: lens.modes[0][1] },
      frameRate: { min: 1, max: 30 }, facingMode: [lens.facing], deviceId: lens.deviceId,
      zoom: lens.facing === 'environment' ? { min: 1, max: 4, step: 0.1 } : undefined,
    });
    const apply = async (k) => {
      const [nw, nh] = closest(lens.modes, ideal(k?.width), ideal(k?.height));
      if (ideal(k?.width)) { c.width = nw; c.height = nh; }
    };
    const patch = (t) => {
      t.getSettings = settings;
      t.getCapabilities = caps;
      t.applyConstraints = apply;
      t.__canvas = c;
      t.__lens = lens;
      return t;
    };
    patch(track);
    const origClone = track.clone.bind(track);
    track.clone = () => patch(origClone());
    return stream;
  };

  const md = navigator.mediaDevices || (navigator.mediaDevices = {});
  md.getUserMedia = async (constraints) => makeStream(constraints);
  md.enumerateDevices = async () => LENSES.map((l) => ({ kind: 'videoinput', deviceId: l.deviceId, label: l.label, groupId: 'fake' }));
  md.getSupportedConstraints = () => ({ width: true, height: true, frameRate: true, facingMode: true, zoom: true, deviceId: true });

  if (!stillSize) { window.ImageCapture = undefined; return; }

  // Поддельный родной снимок: медленный, отклоняет вызовы подряд (так разрешает спецификация).
  window.ImageCapture = class {
    constructor(track) { this.track = track; this.busy = false; }
    async getPhotoCapabilities() {
      if (stillFail) throw new DOMException('camera refused', 'NotSupportedError');
      let [W, H] = this.track.__lens === LENSES[0] ? stillSize : [Math.round(stillSize[0] / 2), Math.round(stillSize[1] / 2)];
      if (stillDepends && this.track.__canvas.width * this.track.__canvas.height > 1920 * 1080) [W, H] = [3264, 2448];
      return { imageWidth: { min: 640, max: W, step: 1 }, imageHeight: { min: 480, max: H, step: 1 } };
    }
    async takePhoto(ps) {
      if (this.busy) { window.__fakeStats.rejected++; throw new DOMException('busy', 'UnknownError'); }
      this.busy = true;
      try {
        window.__fakeStats.takePhoto++;
        await new Promise((r) => setTimeout(r, 300));
        const src = this.track.__canvas;
        let W = ps?.imageWidth || stillSize[0], H = ps?.imageHeight || stillSize[1];
        // Альбомный кадр в альбомный снимок, портретный — в портретный (до поворота «сенсора»).
        if ((src.width >= src.height) !== (W >= H)) [W, H] = [H, W];
        const rot = stillRot % 180 ? [H, W] : [W, H];
        const out = new OffscreenCanvas(rot[0], rot[1]);
        const o = out.getContext('2d');
        o.translate(rot[0] / 2, rot[1] / 2);
        o.rotate((stillRot * Math.PI) / 180);
        o.drawImage(src, -W / 2, -H / 2, W, H);
        return await out.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      } finally { this.busy = false; }
    }
  };
}

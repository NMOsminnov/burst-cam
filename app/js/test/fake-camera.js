// Поддельная камера: getUserMedia отдаёт поток с <canvas> (бегущая полоса, счётчик кадров,
// часы). Нужна для автотестов и для проверки на компьютере без камеры: ?fake или ?fake=3840x2160.
// В рабочий кэш приложения (service worker) не попадает.

export function installFakeCamera(spec) {
  const [w, h] = /^\d+x\d+$/.test(spec || '') ? spec.split('x').map(Number) : [1920, 1080];
  let facing = 'environment';

  const makeStream = (constraints) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    let n = 0;
    let stopped = false;
    const draw = () => {
      if (stopped) return;
      n++;
      const t = performance.now() / 1000;
      ctx.fillStyle = facing === 'user' ? '#123' : '#202830';
      ctx.fillRect(0, 0, w, h);
      // Несимметричная картинка — чтобы тесты могли проверить поворот.
      ctx.fillStyle = '#ffd23f';
      ctx.fillRect(0, 0, w * 0.25, h * 0.15);
      ctx.fillStyle = '#4ac';
      const x = ((t * 0.35) % 1) * w;
      ctx.fillRect(x, h * 0.4, w * 0.08, h * 0.35);
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.round(h / 12)}px sans-serif`;
      ctx.fillText(`FAKE ${w}x${h} #${n} ${facing}`, w * 0.05, h * 0.9);
      setTimeout(draw, 1000 / 30);
    };
    draw();
    const stream = c.captureStream(30);
    const track = stream.getVideoTracks()[0];
    const origStop = track.stop.bind(track);
    track.stop = () => { stopped = true; origStop(); };
    const settings = () => ({ width: w, height: h, frameRate: 30, facingMode: facing, deviceId: 'fake-' + facing });
    track.getSettings = settings;
    track.getCapabilities = () => ({ width: { min: 1, max: w }, height: { min: 1, max: h }, frameRate: { min: 1, max: 30 }, facingMode: [facing], zoom: { min: 1, max: 4, step: 0.1 } });
    track.applyConstraints = async () => {};
    const origClone = track.clone.bind(track);
    track.clone = () => {
      const k = origClone();
      k.getSettings = settings;
      return k;
    };
    return stream;
  };

  const md = navigator.mediaDevices || (navigator.mediaDevices = {});
  md.getUserMedia = async (constraints) => {
    const fm = constraints?.video?.facingMode;
    facing = (fm && (fm.ideal || fm.exact || fm)) === 'user' ? 'user' : 'environment';
    return makeStream(constraints);
  };
  md.enumerateDevices = async () => [
    { kind: 'videoinput', deviceId: 'fake-environment', label: 'Fake back', groupId: 'f' },
    { kind: 'videoinput', deviceId: 'fake-user', label: 'Fake front', groupId: 'f' },
  ];
  md.getSupportedConstraints = () => ({ width: true, height: true, frameRate: true, facingMode: true, zoom: true });
  // takePhoto в подделке нет — одиночный кадр берётся из потока.
  window.ImageCapture = undefined;
}

// Воркер захвата: читает сырые кадры камеры (VideoFrame) через MediaStreamTrackProcessor
// и решает, какие из них стать фото. Главный поток (интерфейс, жесты) кадры вообще не трогает —
// поэтому серия не «заикается», даже если интерфейс занят.
//
// Android/Chromium: процессор создаётся в окне, сюда передаётся его ReadableStream.
// iOS/Safari 18+:   процессор есть только в воркере — сюда передаётся сама дорожка (track).
import { Scheduler } from '../core/scheduler.js';

let sched = null;
let reader = null;
let running = false;
let reportedFirst = false;

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'probe':
      self.postMessage({ type: 'probe', mstp: typeof MediaStreamTrackProcessor !== 'undefined', videoFrame: typeof VideoFrame !== 'undefined' });
      break;
    case 'init':
      init(m).catch((err) => self.postMessage({ type: 'fatal', message: String(err && err.message || err) }));
      break;
    case 'arm': sched?.arm(m); break;
    case 'burst': sched?.burst(m.shotId); break;
    case 'single': sched?.single(m.shotId, { waitStill: m.waitStill }); break;
    case 'still': sched?.still(m.shotId, m.blob); break;
    case 'stop': sched?.stop(m.shotId); break;
    case 'stream': sched?.setStream(m); break;
    case 'close': close(); break;
  }
};

let ownTrack = null; // дорожка, переданная в воркер (путь Safari): останавливать её можем только мы

async function init(m) {
  ownTrack = m.track || null;
  let readable = m.readable;
  if (!readable && m.track) {
    // eslint-disable-next-line no-undef
    readable = new MediaStreamTrackProcessor({ track: m.track }).readable;
  }
  if (!readable) throw new Error('нет источника кадров');

  const ports = m.ports;
  sched = new Scheduler({
    encoders: ports.map((p) => ({ post: (msg, tr) => p.postMessage(msg, tr) })),
    budgetBytes: m.budget,
    emit: (evt, data) => self.postMessage({ type: 'evt', evt, data }),
  });
  sched.setStream({ fps: m.fps, quality: m.quality });
  ports.forEach((p, i) => {
    p.onmessage = (ev) => { if (ev.data.type === 'done') sched.done(i, ev.data.bytes); };
  });

  reader = readable.getReader();
  running = true;
  self.postMessage({ type: 'started' });
  loop();
}

async function loop() {
  // Читаем непрерывно и сразу закрываем ненужные кадры: так в момент нажатия в руках
  // всегда самый свежий кадр, а пул буферов камеры не переполняется.
  while (running) {
    let r;
    try { r = await reader.read(); } catch (err) { break; }
    if (r.done) break;
    const frame = r.value;
    const t = performance.now();
    if (!reportedFirst) {
      reportedFirst = true;
      self.postMessage({
        type: 'frame-info',
        displayWidth: frame.displayWidth, displayHeight: frame.displayHeight,
        codedWidth: frame.codedWidth, codedHeight: frame.codedHeight,
        rotation: frame.rotation || 0, flip: !!frame.flip, format: frame.format,
      });
    }
    if (!sched.wants(t)) { frame.close(); continue; }
    try {
      // Копия в ImageBitmap освобождает буфер камеры сразу, даже если кодировщики ещё заняты.
      const bmp = await createImageBitmap(frame);
      frame.close();
      sched.accept(bmp, t, bmp.width, bmp.height);
    } catch (err) {
      frame.close();
      self.postMessage({ type: 'evt', evt: 'frame-error', data: { message: String(err && err.message || err) } });
    }
  }
  self.postMessage({ type: 'ended' });
}

function close() {
  running = false;
  reader?.cancel().catch(() => {});
  reader = null;
  // Иначе после смены камеры или сворачивания камера осталась бы включённой.
  try { ownTrack?.stop(); } catch { /* уже остановлена */ }
  ownTrack = null;
}

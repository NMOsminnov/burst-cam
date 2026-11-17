// Выбор режима камеры по умолчанию (решение автора, 17.11):
//   1) максимальная частота кадров — в идеале 60 к/с, если камера её даёт;
//   2) при этой частоте — максимальное разрешение («разрешение выкручиваем»);
//   3) при равенстве — режим, при котором родное фото крупнее.
// Частоты сравниваем «ступенями» (60 / 30 / ниже), чтобы 29,97 и 30 не считались разными.

export const fpsTier = (fps) => (fps == null ? 30 : fps >= 50 ? 60 : fps >= 25 ? 30 : Math.round(fps));

const area = (a) => (a ? a[0] * a[1] : 0);

/**
 * @param {{width: number, height: number, fps: number|null, photo?: [number, number]|null}[]} modes
 * @returns {object|null}
 */
export function pickDefaultMode(modes) {
  let best = null;
  for (const m of modes || []) {
    if (!best) { best = m; continue; }
    const d = fpsTier(m.fps) - fpsTier(best.fps)
      || m.width * m.height - best.width * best.height
      || area(m.photo) - area(best.photo);
    if (d > 0) best = m;
  }
  return best;
}

/** Тот же ли режим (разрешение и ступень частоты). */
export const sameMode = (a, b) => !!a && !!b && a.width === b.width && a.height === b.height && fpsTier(a.fps) === fpsTier(b.fps);

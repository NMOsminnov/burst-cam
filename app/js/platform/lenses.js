// Объективы телефона. Браузер отдаёт камеры списком enumerateDevices(), но по-разному:
//  • Android/Chrome: часто каждый объектив — отдельная камера с ярлыком «camera2 2, facing back»
//    (какой из них ультраширик, браузер не говорит); на части телефонов (Pixel) все задние
//    объективы спрятаны за одной «логической» камерой — тогда ультраширик только через зум < 1×;
//  • iOS/Safari: ярлыки вида «Back Ultra Wide Camera» / «Сверхширокоугольная камера…»,
//    плюс «составные» камеры (Dual/Triple), которые сами переключают объективы при зуме.

const RX = {
  front: /front|user|фронт|передн|facing front|selfie/i,
  ultra: /ultra|сверхшир|ультраш|ultrawide|0[.,]5/i,
  tele: /tele|теле|zoom/i,
  multi: /dual|triple|двойн|тройн|двухкам|трёхкам|трехкам/i,
  back: /back|rear|environment|задн|основн|facing back/i,
};

/**
 * Разобрать ярлык камеры.
 * @returns {{kind: 'front'|'ultra'|'tele'|'multi'|'wide'|'unknown', facing: 'user'|'environment'|null}}
 */
export function classifyLens(label = '') {
  const l = String(label);
  if (RX.front.test(l)) return { kind: 'front', facing: 'user' };
  if (RX.ultra.test(l)) return { kind: 'ultra', facing: 'environment' };
  if (RX.tele.test(l)) return { kind: 'tele', facing: 'environment' };
  if (RX.multi.test(l)) return { kind: 'multi', facing: 'environment' };
  if (RX.back.test(l)) return { kind: 'wide', facing: 'environment' };
  return { kind: 'unknown', facing: null };
}

const NAMES = { ultra: 'Ультраширокая', tele: 'Телевик', multi: 'Составная', wide: 'Основная', front: 'Фронтальная' };
const SHORT = { ultra: '0,5×', tele: 'Теле', multi: 'Авто', wide: '1×', front: 'Фронт' };

/**
 * Список объективов для интерфейса.
 * @param {{deviceId: string, label: string, kind: string}[]} devices  — результат enumerateDevices()
 */
export function describeLenses(devices) {
  const cams = devices.filter((d) => d.kind === 'videoinput' && d.deviceId);
  const out = cams.map((d) => ({ deviceId: d.deviceId, label: d.label, ...classifyLens(d.label) }));
  // Неизвестные ярлыки (Android: «camera2 N, facing back» уже распознан как задняя;
  // совсем пустые — до разрешения на камеру) нумеруем.
  for (const l of out) if (!l.facing) l.facing = 'environment';
  // Задние без подписи объектива («Back Camera», «camera2 0, facing back»): одна — это основная,
  // несколько — нумеруем (браузер не говорит, какая из них какая).
  const plain = out.filter((l) => l.facing === 'environment' && (l.kind === 'wide' || l.kind === 'unknown'));
  let n = 0;
  for (const l of out) {
    if (l.facing === 'user') { l.name = NAMES.front; l.short = SHORT.front; }
    else if (plain.includes(l)) {
      n++;
      l.name = plain.length === 1 ? NAMES.wide : `Задняя ${n}`;
      l.short = plain.length === 1 ? SHORT.wide : `К${n}`;
    } else { l.name = NAMES[l.kind]; l.short = SHORT[l.kind]; }
  }
  const backs = out.filter((l) => l.facing === 'environment');
  const ultraKnown = out.some((l) => l.kind === 'ultra');
  return { lenses: out, backs, ultraKnown };
}

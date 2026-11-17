// Распознавание нажатия на кнопку спуска: короткое — одно фото, удержание — серия.
// Никаких переключателей режима: серия — это просто «держу кнопку», как в системной камере.

/**
 * @param {object} o
 * @param {number} o.holdMs
 * @param {(shotId: number) => void} o.onArm      палец коснулся — взять кадр немедленно
 * @param {(shotId: number) => void} o.onBurst    держат дольше holdMs — пошла серия
 * @param {(shotId: number, kind: 'single'|'burst') => void} o.onRelease
 */
export function createPress({ holdMs, onArm, onBurst, onRelease, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let pressed = false;
  let bursting = false;
  let timer = null;
  let shotId = 0;
  return {
    get pressed() { return pressed; },
    get bursting() { return bursting; },
    down() {
      if (pressed) return;
      pressed = true;
      bursting = false;
      shotId++;
      const id = shotId;
      onArm(id);
      timer = setTimer(() => {
        timer = null;
        if (!pressed || id !== shotId) return;
        bursting = true;
        onBurst(id);
      }, holdMs);
    },
    up() {
      if (!pressed) return;
      pressed = false;
      if (timer) { clearTimer(timer); timer = null; }
      const kind = bursting ? 'burst' : 'single';
      bursting = false;
      onRelease(shotId, kind);
    },
  };
}

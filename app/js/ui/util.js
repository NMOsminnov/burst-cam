// Мелочи интерфейса: адреса миниатюр, подтверждение, тост, навигация «назад», формат.

// ---------- Миниатюры ----------
const thumbUrls = new Map();
export function thumbUrl(meta) {
  let u = thumbUrls.get(meta.id);
  if (!u && meta.thumb) { u = URL.createObjectURL(meta.thumb); thumbUrls.set(meta.id, u); }
  return u || '';
}
export function forgetThumbs(ids) {
  for (const id of ids) {
    const u = thumbUrls.get(id);
    if (u) { URL.revokeObjectURL(u); thumbUrls.delete(id); }
  }
}

// ---------- Подтверждение ----------
export function confirmDelete(text, okLabel = 'Удалить') {
  const box = document.getElementById('confirm');
  document.getElementById('confirm-text').textContent = text;
  const ok = document.getElementById('confirm-ok');
  const cancel = document.getElementById('confirm-cancel');
  ok.textContent = okLabel;
  box.hidden = false;
  return new Promise((resolve) => {
    const finish = (v) => {
      box.hidden = true;
      ok.onclick = cancel.onclick = box.onclick = null;
      resolve(v);
    };
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    box.onclick = (e) => { if (e.target === box) finish(false); };
    cancel.focus();
  });
}

// ---------- Тост ----------
let toastTimer = null;
export function toast(text, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- Навигация: системная кнопка «назад» закрывает верхний экран ----------
const stack = [];
export const nav = {
  init() {
    history.replaceState({ depth: 0 }, '');
    addEventListener('popstate', () => {
      const v = stack.pop();
      if (v) v.hide();
    });
  },
  open(view) {
    stack.push(view);
    history.pushState({ depth: stack.length }, '');
  },
  back() {
    if (stack.length) history.back();
  },
  get depth() { return stack.length; },
  top() { return stack[stack.length - 1] || null; },
};

// ---------- Формат ----------
export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
export const photosWord = (n) => `${n} ${plural(n, 'фото', 'фото', 'фото')}`;

export function mb(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2).replace('.', ',') + ' ГБ';
  return (bytes / 1024 ** 2).toFixed(bytes > 100 * 1024 ** 2 ? 0 : 1).replace('.', ',') + ' МБ';
}

export function mp(w, h) {
  return ((w * h) / 1e6).toFixed(1).replace('.', ',').replace(',0', '') + ' Мп';
}

export function when(ts) {
  const d = new Date(ts);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return same ? `Сегодня, ${time}` : `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}, ${time}`;
}

export function fileName(meta) {
  const d = new Date(meta.createdAt);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `BurstCam_${stamp}_${p(meta.idx, 3)}.jpg`;
}

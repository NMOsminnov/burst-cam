// «Сохранить / поделиться». Веб-приложение не может само записать файл в «Фото» телефона,
// поэтому открываем системное меню «Поделиться» (там есть «Сохранить изображение» на iPhone
// и «Сохранить в галерею»/«Файлы» на Android). Где меню нет — скачиваем файлы.
import { getBlob } from '../core/store.js';
import { fileName, toast } from './util.js';

let prepared = { key: '', files: null };

/**
 * @param {object[]} metas
 * @param {Map<string, Blob>} [known]  уже прочитанные файлы (чтобы не терять «жест пользователя»)
 */
export async function sharePhotos(metas, known = new Map()) {
  if (!metas.length) return;
  const key = metas.map((m) => m.id).join('|');
  let files = prepared.key === key ? prepared.files : null;
  if (!files) {
    files = await Promise.all(
      metas.map(async (m) => {
        const blob = known.get(m.id) || (await getBlob(m.id));
        return blob ? new File([blob], fileName(m), { type: blob.type || 'image/jpeg', lastModified: m.createdAt }) : null;
      }),
    );
    files = files.filter(Boolean);
    prepared = { key, files };
  }

  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
      prepared = { key: '', files: null };
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // пользователь закрыл меню
      if (e.name === 'NotAllowedError') {
        // Чтение файлов заняло слишком долго и браузер «забыл» нажатие — файлы уже готовы.
        toast('Нажмите ещё раз, чтобы поделиться');
        return;
      }
      console.warn('share:', e);
    }
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
  toast(files.length > 1 ? `Скачивание: ${files.length} файлов` : 'Скачивание началось');
}

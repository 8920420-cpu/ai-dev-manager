/**
 * Сервис доступа к файловой системе (выбор папки проекта/сканера).
 *
 * Способы по приоритету (первый успешный выигрывает):
 *  1. HOST-RUNNER мост — нативный host-runner крутится на той же машине, что и
 *     браузер, и открывает системный диалог ОС, возвращая АБСОЛЮТНЫЙ путь.
 *     Браузер зовёт его напрямую по localhost (см. host-runner/.../folderPicker.js).
 *     Это основной способ при контейнерном orchestrator (внутри Linux-контейнера
 *     нативного диалога нет).
 *  2. BACKEND `POST /api/fs/pick-folder` — если orchestrator-backend запущен
 *     нативно на Windows-хосте (не в контейнере).
 *  3. БРАУЗЕРНЫЙ File System Access API (`window.showDirectoryPicker`) — fallback.
 *     ОГРАНИЧЕНИЕ: браузер НЕ отдаёт абсолютный путь, только имя папки.
 *  4. Если ничего не доступно — ручной ввод/вставка пути в поле.
 */
import { http, ApiError } from './http';

// Адрес host-runner picker-моста. Браузер и host-runner на одной машине.
// Переопределяется через VITE_HOST_PICKER_URL на этапе сборки фронтенда.
const HOST_PICKER_URL =
  (import.meta.env?.VITE_HOST_PICKER_URL as string | undefined)?.replace(/\/+$/, '') ||
  'http://localhost:4187';

export interface PickedFolder {
  /** Имя выбранной папки (всё, что отдаёт браузер). */
  name: string;
  /** Абсолютный путь, если его удалось получить (нативный диалог). */
  absolutePath: string | null;
  /** Способ получения. */
  source: 'native' | 'directory-picker' | 'manual';
}

interface DirHandleLike {
  name: string;
}
type ShowDirectoryPicker = () => Promise<DirHandleLike>;

function getPicker(): ShowDirectoryPicker | null {
  const w = window as unknown as { showDirectoryPicker?: ShowDirectoryPicker };
  return typeof w.showDirectoryPicker === 'function'
    ? w.showDirectoryPicker.bind(w)
    : null;
}

interface PickFolderResponse {
  ok: boolean;
  path: string | null;
  cancelled: boolean;
}

function toPicked(res: PickFolderResponse): PickedFolder | null {
  if (res.cancelled || !res.path) return null; // пользователь отменил
  const name = res.path.split(/[\\/]/).filter(Boolean).pop() ?? res.path;
  return { name, absolutePath: res.path, source: 'native' };
}

/** Открыть нативный диалог через host-runner мост. null — отмена; throws — недоступен. */
async function pickFolderHostRunner(): Promise<PickedFolder | null> {
  const r = await fetch(`${HOST_PICKER_URL}/pick-folder`, { method: 'POST' });
  if (!r.ok) throw new ApiError(`host picker HTTP ${r.status}`, r.status);
  return toPicked((await r.json()) as PickFolderResponse);
}

/** Открыть нативный диалог на хосте backend. null — отмена; throws — недоступен. */
async function pickFolderBackend(): Promise<PickedFolder | null> {
  const res = await http.post<PickFolderResponse>('/api/fs/pick-folder');
  return toPicked(res);
}

/** Открыть браузерный выбор папки (только имя, без абсолютного пути). */
async function pickFolderBrowser(): Promise<PickedFolder | null> {
  const picker = getPicker();
  if (!picker) throw new Error('Системный выбор папки недоступен в этом браузере');
  try {
    const handle = await picker();
    return {
      name: handle.name,
      absolutePath: null, // браузер не раскрывает абсолютный путь
      source: 'directory-picker',
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}

export const fsAccess = {
  /** Доступен ли хоть какой-то системный выбор папки (нативный или браузерный). */
  isDirectoryPickerSupported(): boolean {
    return getPicker() !== null;
  },

  /**
   * Открыть системный выбор папки.
   *
   * Цепочка fallback: host-runner мост → backend-эндпоинт → браузерный picker.
   * Первые два дают абсолютный путь; браузерный — только имя папки.
   *
   * @returns PickedFolder или null, если пользователь отменил.
   */
  async pickFolder(): Promise<PickedFolder | null> {
    // 1. host-runner мост (основной путь при контейнерном orchestrator).
    try {
      return await pickFolderHostRunner();
    } catch {
      // мост не запущен / недоступен — пробуем следующий способ
    }
    // 2. backend на host (если запущен не в контейнере).
    try {
      return await pickFolderBackend();
    } catch (e) {
      const unavailable =
        e instanceof ApiError && (e.status === 404 || e.status === 501 || e.status === 0);
      if (!unavailable) throw e;
    }
    // 3. браузерный picker (только имя папки).
    if (getPicker()) return pickFolderBrowser();
    throw new Error('Системный выбор папки недоступен — введите путь вручную');
  },
};

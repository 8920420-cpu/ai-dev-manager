/**
 * Сервис доступа к файловой системе (выбор папки проекта).
 *
 * ОГРАНИЧЕНИЕ БРАУЗЕРА: из соображений безопасности браузеры НЕ отдают
 * абсолютный путь к выбранной папке. File System Access API
 * (`window.showDirectoryPicker`) возвращает только имя папки и дескриптор.
 *
 * Поэтому:
 *  1. Если API доступен — открываем системный диалог и берём имя папки как
 *     подсказку, но абсолютный путь пользователь подтверждает/вводит вручную.
 *  2. Абсолютный путь — основной надёжный способ (ручной ввод/вставка).
 *  3. ⚠️ BACKEND_REQUIRED: для настоящего выбора абсолютного пути нужен
 *     backend/Electron диалог (нативный picker). Контракт ниже к этому готов.
 */

export interface PickedFolder {
  /** Имя выбранной папки (всё, что отдаёт браузер). */
  name: string;
  /** Абсолютный путь, если его удалось получить (браузер обычно не даёт). */
  absolutePath: string | null;
  /** Способ получения. */
  source: 'directory-picker' | 'manual';
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

export const fsAccess = {
  /** Поддерживается ли системный диалог выбора папки. */
  isDirectoryPickerSupported(): boolean {
    return getPicker() !== null;
  },

  /**
   * Открыть системный выбор папки.
   * @returns PickedFolder или null, если пользователь отменил.
   * @throws если API недоступен (проверяйте isDirectoryPickerSupported заранее).
   */
  async pickFolder(): Promise<PickedFolder | null> {
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
      // AbortError — пользователь закрыл диалог
      if (e instanceof DOMException && e.name === 'AbortError') return null;
      throw e;
    }
  },
};

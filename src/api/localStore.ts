/**
 * Локальное хранилище-репозиторий поверх localStorage.
 *
 * ⚠️ ВРЕМЕННАЯ РЕАЛИЗАЦИЯ. Backend оркестратора пока предоставляет API только
 * для настроек БД (см. settingsApi). Для проектов, интеграций и назначения
 * ролей серверных endpoint-ов ещё нет, поэтому эти сущности хранятся локально
 * в браузере. Контракты репозиториев типизированы так, чтобы при появлении
 * backend замена localStorage на http-вызовы не затрагивала UI.
 *
 * ЗАПРЕЩЕНО хранить здесь любые секреты (пароли, токены) — только несекретные
 * данные конфигурации.
 */

const PREFIX = 'adm.';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Событие изменения коллекции — чтобы UI (напр. меню) мог обновиться. */
export const STORE_CHANGE_EVENT = 'adm-store-change';

function write<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    window.dispatchEvent(new CustomEvent(STORE_CHANGE_EVENT, { detail: { key } }));
  } catch {
    /* квота/приватный режим — тихо игнорируем */
  }
}

/** Имитация сетевой задержки, чтобы UI-состояния loading были реалистичны. */
function delay<T>(value: T, ms = 220): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** Репозиторий коллекции сущностей с полем id. */
export function createCollectionRepo<T extends { id: string }>(key: string) {
  return {
    async list(): Promise<T[]> {
      return delay(read<T[]>(key, []));
    },
    async saveAll(items: T[]): Promise<T[]> {
      write(key, items);
      return delay(items, 80);
    },
  };
}

export const localStore = { read, write, delay };

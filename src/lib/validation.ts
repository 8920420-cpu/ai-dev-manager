/** Чистые функции валидации форм. Возвращают текст ошибки или null. */

export function required(value: string, label = 'Поле'): string | null {
  return value.trim().length === 0 ? `${label} обязательно для заполнения` : null;
}

/** Проверка http(s)-URL коннектора. */
export function validUrl(value: string): string | null {
  const v = value.trim();
  if (!v) return 'Укажите адрес';
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return 'Некорректный URL (пример: http://localhost:4187)';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Адрес должен начинаться с http:// или https://';
  }
  return null;
}

/** Хост: непустой, без схемы и пробелов. */
export function validHost(value: string): string | null {
  const v = value.trim();
  if (!v) return 'Укажите адрес сервера';
  if (/\s/.test(v)) return 'Адрес не должен содержать пробелов';
  return null;
}

/**
 * Абсолютный путь к каталогу. Поддерживает POSIX (`/...`), Windows-диск
 * (`C:\...` или `C:/...`) и UNC (`\\server\share`). Проверяется только синтаксис —
 * существование каталога проверяет scanner-service, т.к. путь может относиться к
 * другой машине или Docker-mount.
 */
export function isAbsolutePath(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (v.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(v)) return true;
  if (/^\\\\/.test(v)) return true;
  return false;
}

/** Порт TCP: 1..65535. */
export function validPort(value: string | number): string | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return 'Порт должен быть числом от 1 до 65535';
  }
  return null;
}

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

/** Порт TCP: 1..65535. */
export function validPort(value: string | number): string | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return 'Порт должен быть числом от 1 до 65535';
  }
  return null;
}

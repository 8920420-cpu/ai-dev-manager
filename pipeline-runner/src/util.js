// Небольшие чистые помощники без побочных эффектов.
import path from 'node:path';

/** Округление числа до указанного количества знаков. */
export function round(n, digits = 0) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Идентификатор запуска в формате 2026-06-21T14-22-15 (локальное время).
 * Двоеточия заменены на дефисы, чтобы значение можно было использовать
 * как имя каталога на любой ОС.
 */
export function makeRunId(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
  );
}

/** Путь для возврата оркестратору: относительный от cwd с прямыми слэшами. */
export function toReturnPath(absPath, cwd = process.cwd()) {
  const rel = path.relative(cwd, absPath);
  return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : absPath;
}

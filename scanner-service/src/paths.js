// Безопасный резолв путей наблюдения Scanner.
//
// Контракт (orchestrator P0.1 / scanner P1.1): `watchDirectory` — корень
// наблюдения (нормализованный абсолютный путь), относительное имя документа —
// отдельная настройка с default `claude-tasks.json`. Имя документа не должно
// выходить за выбранный каталог через `..`, абсолютную подстановку или symlink.
// Пути нормализуем средствами ТЕКУЩЕЙ ОС: подменять host path container path
// нельзя — несоответствие ОС обнаружится проверкой существования каталога.
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, dirname, sep } from 'node:path';

// rel выходит за корень, если он равен '..' или начинается с '..<разделитель>'.
// Проверяем по сегменту, а не по префиксу строки, чтобы не отвергнуть валидное
// имя вроде '..foo.json'.
function escapesRoot(rel) {
  return !rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel);
}

// Стабильные машинные коды readiness/конфигурации (привязываются к projectId/stageId).
export const SCANNER_READY_CODE = {
  WATCH_DIR_REQUIRED: 'scanner_watch_directory_required',
  WATCH_DIR_ABSOLUTE: 'scanner_watch_directory_must_be_absolute',
  WATCH_DIR_UNAVAILABLE: 'scanner_watch_directory_unavailable',
  DOCUMENT_NAME_REQUIRED: 'scanner_document_name_required',
  DOCUMENT_PATH_ESCAPE: 'scanner_document_path_escape',
};

// Ошибка конфигурации со стабильным машинным кодом (не содержит путей в message
// на случай логирования вызывающим — код самодостаточен для диагностики).
export class ScannerConfigError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'ScannerConfigError';
    this.code = code;
  }
}

const DEFAULT_DOCUMENT_NAME = 'claude-tasks.json';

/**
 * Синтаксическая проверка абсолютного пути (кросс-платформенно). Совпадает с
 * orchestrator stages.isAbsolutePath: Windows-диск, UNC и POSIX. Используем её,
 * а не path.isAbsolute, чтобы Scanner на Linux всё равно признавал `K:\...`
 * валидным абсолютным путём конфигурации (его существование проверится отдельно).
 */
export function isAbsolutePathSyntax(value) {
  const p = String(value ?? '');
  if (/^[A-Za-z]:[\\/]/.test(p)) return true; // C:\ или C:/
  if (/^\\\\/.test(p)) return true; // \\server\share (UNC)
  if (/^\/\//.test(p)) return true; // //server/share
  if (/^\//.test(p)) return true; // /home/user (POSIX)
  return false;
}

// Пустая строка/пробелы не считаются значением каталога → null.
export function normalizeWatchDirectory(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed.length ? trimmed : null;
}

/**
 * Проверить watchDirectory как значение конфигурации (без обращения к ФС):
 * непустой и синтаксически абсолютный. Бросает ScannerConfigError с кодом.
 * Возвращает нормализованную строку.
 */
export function requireWatchDirectory(watchDirectory) {
  const dir = normalizeWatchDirectory(watchDirectory);
  if (!dir) {
    throw new ScannerConfigError(
      SCANNER_READY_CODE.WATCH_DIR_REQUIRED,
      'watchDirectory is required for an enabled Scanner stage',
    );
  }
  if (!isAbsolutePathSyntax(dir)) {
    throw new ScannerConfigError(
      SCANNER_READY_CODE.WATCH_DIR_ABSOLUTE,
      'watchDirectory must be an absolute path',
    );
  }
  return dir;
}

/**
 * Резолв пути документа внутри watchDirectory с защитой от выхода за каталог.
 * documentName — относительное имя; абсолютная подстановка и `..`-escape
 * отклоняются. Возвращает { watchDirectory, documentPath } (оба — текущей ОС).
 */
export function resolveDocumentPath(watchDirectory, documentName = DEFAULT_DOCUMENT_NAME) {
  const dir = requireWatchDirectory(watchDirectory);
  const name = String(documentName ?? '').trim();
  if (!name) {
    throw new ScannerConfigError(
      SCANNER_READY_CODE.DOCUMENT_NAME_REQUIRED,
      'document name is required',
    );
  }
  // Абсолютное имя документа — подмена корня наблюдения, запрещено.
  if (isAbsolute(name) || isAbsolutePathSyntax(name)) {
    throw new ScannerConfigError(
      SCANNER_READY_CODE.DOCUMENT_PATH_ESCAPE,
      'document name must be relative to watchDirectory',
    );
  }
  const root = resolve(dir);
  const documentPath = resolve(root, name);
  const rel = relative(root, documentPath);
  // rel пустой (==каталог), выходит за корень или сам абсолютный → escape.
  if (escapesRoot(rel)) {
    throw new ScannerConfigError(
      SCANNER_READY_CODE.DOCUMENT_PATH_ESCAPE,
      'document path escapes watchDirectory',
    );
  }
  return { watchDirectory: root, documentPath };
}

const DEFAULT_NAME = DEFAULT_DOCUMENT_NAME;
export { DEFAULT_NAME as DEFAULT_DOCUMENT_NAME };

/**
 * Проверка доступности каталога наблюдения в ФС: существует, это каталог,
 * читается, и реальный (после раскрытия symlink) путь документа не выходит за
 * реальный watchDirectory. Возвращает { ok:true } либо { ok:false, code }.
 * Не бросает на отсутствии/правах — это ожидаемое состояние конфигурации.
 */
export async function checkWatchDirectory(watchDirectory, documentPath) {
  const root = resolve(watchDirectory);
  let st;
  try {
    st = await stat(root);
  } catch {
    return { ok: false, code: SCANNER_READY_CODE.WATCH_DIR_UNAVAILABLE };
  }
  if (!st.isDirectory()) return { ok: false, code: SCANNER_READY_CODE.WATCH_DIR_UNAVAILABLE };
  try {
    await access(root, constants.R_OK);
  } catch {
    return { ok: false, code: SCANNER_READY_CODE.WATCH_DIR_UNAVAILABLE };
  }
  // Symlink escape: сравниваем РЕАЛЬНЫЕ пути. Документ может ещё не существовать,
  // поэтому раскрываем его каталог, а не сам файл.
  try {
    const realRoot = await realpath(root);
    const realDocDir = await realDirOf(documentPath ?? root);
    const rel = relative(realRoot, realDocDir);
    // rel === '' допустимо: документ лежит прямо в корне.
    if (rel && escapesRoot(rel)) {
      return { ok: false, code: SCANNER_READY_CODE.DOCUMENT_PATH_ESCAPE };
    }
  } catch {
    return { ok: false, code: SCANNER_READY_CODE.WATCH_DIR_UNAVAILABLE };
  }
  return { ok: true };
}

// realpath каталога, в котором лежит (или будет лежать) документ. Если документ
// ещё не создан — раскрываем существующий родитель.
async function realDirOf(documentPath) {
  const dir = dirname(resolve(documentPath));
  try {
    return await realpath(dir);
  } catch {
    // Каталог документа отсутствует — поднимаемся к watchDirectory (его realpath
    // уже проверен вызывающим); вернём сам путь без раскрытия.
    return dir;
  }
}

// Раскрыть symlink самого каталога, если это symlink (для теста escape).
export async function isSymlink(path) {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

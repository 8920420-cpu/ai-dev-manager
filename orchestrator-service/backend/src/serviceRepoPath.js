// SERVICE-REPO-PATH-001 — резолвинг каталога сервиса (services.repository_path).
//
// Инцидент: у авторегистрируемых сервисов repository_path = NULL (или устарел),
// пустой путь проходит как «сервис в корне проекта» → PIPELINE_SERVICE ищет
// docker-compose.yml от КОРНЯ репозитория, где его нет (компоузы лежат в
// подсистемах), и падает pipeline_compose_not_found мгновенно.
//
// Здесь:
//  - deriveServicePathFromFiles — вывод каталога сервиса из общего префикса путей
//    work_item/файлов сдачи (для заполнения при авторегистрации);
//  - findServiceDirByCode — автодетект/бэкфилл: поиск каталога по КОДУ сервиса
//    (точное совпадение имени каталога на глубине ≤ maxDepth в корне проекта);
//  - serviceDirExists — проверка, что каталог сервиса реально существует;
//  - resolveServiceRepoPath — единая точка для claim: сохранить валидный путь,
//    иначе бэкфилл по коду, иначе диагностируемый провал service_path_unresolved.

import fs from 'node:fs';
import path from 'node:path';
import { isServicePathSafe } from './pipelineDispatch.js';

// Каталоги-«шум»: не сервисы, но встречаются на глубине ≤3 и раздувают обход /
// плодят ложные совпадения. Скрытые (начинающиеся с точки) отсекаем отдельно.
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor',
  'venv', '__pycache__', 'bin', 'obj', 'tmp', 'temp',
]);

function toPosix(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

/**
 * Каталог сервиса из общего каталогового префикса путей файлов work_item.
 * Вход: массив строк-путей или объектов { path }. Возвращает относительный
 * POSIX-путь (без завершающего слэша) или '' — если общего префикса нет либо он
 * небезопасен. Абсолютные пути и пути с диск-префиксом игнорируются.
 */
export function deriveServicePathFromFiles(files) {
  const rels = (Array.isArray(files) ? files : [])
    .map((f) => toPosix(typeof f === 'string' ? f : f?.path).trim())
    .filter(Boolean)
    .filter((p) => !/^([a-zA-Z]:|\/)/.test(p)) // только относительные
    .map((p) => p.replace(/^\.\//, '').replace(/^\/+/, ''));
  if (!rels.length) return '';
  const split = rels.map((p) => p.split('/'));
  // Общий префикс считаем по КАТАЛОГОВЫМ сегментам (последний сегмент — имя файла).
  const first = split[0];
  let commonLen = first.length - 1;
  for (const segs of split) {
    const dirLen = segs.length - 1;
    if (dirLen < commonLen) commonLen = dirLen;
    for (let i = 0; i < commonLen; i += 1) {
      if (segs[i] !== first[i]) { commonLen = i; break; }
    }
  }
  const prefix = first.slice(0, commonLen).join('/');
  return isServicePathSafe(prefix) ? prefix : '';
}

/**
 * Существует ли каталог сервиса rootPath/repositoryPath на диске.
 * Пустой/небезопасный repositoryPath → false (пустой путь = «сервис в корне»,
 * что для конвейера равнозначно отсутствию каталога сервиса).
 */
export function serviceDirExists(rootPath, repositoryPath) {
  const root = String(rootPath ?? '').trim();
  const rel = toPosix(repositoryPath).trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (!root || !rel) return false;
  if (!isServicePathSafe(rel)) return false;
  try {
    return fs.statSync(path.resolve(root, rel)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Найти каталог сервиса по его КОДУ: точное (регистронезависимое) совпадение
 * имени каталога на глубине ≤ maxDepth от корня проекта. Возвращает относительный
 * POSIX-путь, если найдено РОВНО одно совпадение; null — если совпадений нет или
 * их несколько (неоднозначно — молча не угадываем).
 */
export function findServiceDirByCode(rootPath, serviceCode, { maxDepth = 3 } = {}) {
  const root = String(rootPath ?? '').trim();
  const code = String(serviceCode ?? '').trim();
  if (!root || !code) return null;
  const codeLc = code.toLowerCase();
  try {
    if (!fs.statSync(root).isDirectory()) return null;
  } catch {
    return null;
  }
  const matches = new Set();
  let frontier = [{ abs: root, rel: '', depth: 0 }];
  while (frontier.length) {
    const next = [];
    for (const node of frontier) {
      if (node.depth >= maxDepth) continue;
      let entries;
      try {
        entries = fs.readdirSync(node.abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const name = ent.name;
        if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
        const rel = node.rel ? `${node.rel}/${name}` : name;
        if (name.toLowerCase() === codeLc) matches.add(rel);
        next.push({ abs: path.join(node.abs, name), rel, depth: node.depth + 1 });
      }
    }
    frontier = next;
  }
  if (matches.size !== 1) return null; // нет совпадений или неоднозначно
  const only = [...matches][0];
  return isServicePathSafe(only) ? only : null;
}

/**
 * Резолв каталога сервиса для claim PIPELINE_SERVICE.
 *  1) текущий repository_path валиден и каталог существует → оставить как есть;
 *  2) иначе — бэкфилл по коду (findServiceDirByCode); нашли один → отдать его;
 *  3) иначе — диагностируемый провал service_path_unresolved (НЕ запускать
 *     конвейер от корня).
 *
 * Возвращает { ok: true, repositoryPath, changed } или
 * { ok: false, code: 'service_path_unresolved', message }.
 */
export function resolveServiceRepoPath(rootPath, serviceCode, repositoryPath, opts = {}) {
  const current = toPosix(repositoryPath).trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (current && isServicePathSafe(current) && serviceDirExists(rootPath, current)) {
    return { ok: true, repositoryPath: current, changed: false };
  }
  const found = findServiceDirByCode(rootPath, serviceCode, opts);
  if (found) return { ok: true, repositoryPath: found, changed: found !== current };
  const code = String(serviceCode ?? '').trim() || '(без кода)';
  return {
    ok: false,
    code: 'service_path_unresolved',
    message: `сервис ${code}: repository_path не задан/не найден, укажите каталог сервиса`,
  };
}

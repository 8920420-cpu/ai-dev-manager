// TOOLS-SERVICE-001 — исполнение встроенных (builtin) инструментов чтения проекта.
//
// Все инструменты работают ТОЛЬКО внутри корня проекта (root) — песочница строго
// ограничивает доступ этим каталогом (никаких '..' за пределы root). root приходит
// от оркестратора (projects.root_path / docs_path конкретной задачи).
import { readFile, readdir, stat, writeFile, unlink, mkdir } from 'node:fs/promises';
import { resolve, sep, relative, dirname } from 'node:path';

// Каталоги, которые не обходим при поиске/листинге (служебные/тяжёлые).
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache']);

/**
 * Безопасно разрешить относительный путь внутри root. Возвращает абсолютный путь
 * или null, если путь выходит за пределы root (защита от '..'/абсолютных путей).
 */
export function safeResolve(root, rel) {
  const base = resolve(String(root ?? ''));
  if (!base) return null;
  const abs = resolve(base, String(rel ?? '.'));
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs;
}

function toolError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function requireRoot(root) {
  const base = String(root ?? '').trim();
  if (!base) throw toolError('root_required', 'Не задан корень проекта (root).');
  return base;
}

/** read_file: вернуть содержимое файла (с обрезкой по maxBytes). */
export async function readFileTool({ root, path: rel, maxBytes = 64 * 1024 } = {}) {
  requireRoot(root);
  if (!rel) throw toolError('path_required', 'Укажите путь файла (path).');
  const abs = safeResolve(root, rel);
  if (!abs) throw toolError('path_outside_root', 'Путь выходит за пределы проекта.');
  const limit = Math.max(1, Math.min(Number(maxBytes) || 65536, 1 << 20));
  let data;
  try {
    data = await readFile(abs, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw toolError('not_found', `Файл не найден: ${rel}`);
    if (e.code === 'EISDIR') throw toolError('is_directory', `Это каталог, не файл: ${rel}`);
    throw e;
  }
  const truncated = data.length > limit;
  return {
    path: rel,
    content: truncated ? data.slice(0, limit) : data,
    truncated,
    bytes: Buffer.byteLength(data),
  };
}

/** list_dir: список содержимого каталога (имя + тип). */
export async function listDirTool({ root, path: rel = '.' } = {}) {
  requireRoot(root);
  const abs = safeResolve(root, rel);
  if (!abs) throw toolError('path_outside_root', 'Путь выходит за пределы проекта.');
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') throw toolError('not_found', `Каталог не найден: ${rel}`);
    if (e.code === 'ENOTDIR') throw toolError('not_directory', `Это не каталог: ${rel}`);
    throw e;
  }
  return {
    path: rel,
    entries: entries
      .filter((e) => !e.name.startsWith('.') || e.name === '.env.example')
      .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)),
  };
}

/** search_text: подстрочный поиск (без регэкспа) по тексту файлов проекта. */
export async function searchTextTool({ root, query, maxResults = 100, maxFileBytes = 512 * 1024 } = {}) {
  requireRoot(root);
  const needle = String(query ?? '').trim();
  if (!needle) throw toolError('query_required', 'Укажите строку поиска (query).');
  const base = resolve(root);
  const limit = Math.max(1, Math.min(Number(maxResults) || 100, 1000));
  const matches = [];
  const lower = needle.toLowerCase();

  async function walk(dir) {
    if (matches.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= limit) return;
      if (entry.name.startsWith('.')) continue;
      const abs = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(abs);
      } else if (entry.isFile()) {
        let info;
        try {
          info = await stat(abs);
        } catch {
          continue;
        }
        if (info.size > maxFileBytes) continue;
        let content;
        try {
          content = await readFile(abs, 'utf8');
        } catch {
          continue; // бинарный/нечитаемый — пропускаем
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(lower)) {
            matches.push({ file: relative(base, abs).split(sep).join('/'), line: i + 1, text: lines[i].trim().slice(0, 300) });
            if (matches.length >= limit) break;
          }
        }
      }
    }
  }

  await walk(base);
  return { query: needle, matches, truncated: matches.length >= limit };
}

/** edit_file (modify): заменить точный фрагмент oldText на newText в файле. */
export async function editFileTool({ root, path: rel, oldText, newText } = {}) {
  requireRoot(root);
  if (!rel) throw toolError('path_required', 'Укажите путь файла (path).');
  if (oldText == null || oldText === '') throw toolError('old_text_required', 'Укажите oldText для замены.');
  const abs = safeResolve(root, rel);
  if (!abs) throw toolError('path_outside_root', 'Путь выходит за пределы проекта.');
  let data;
  try {
    data = await readFile(abs, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw toolError('not_found', `Файл не найден: ${rel}`);
    throw e;
  }
  const idx = data.indexOf(String(oldText));
  if (idx === -1) throw toolError('old_text_not_found', 'Фрагмент oldText не найден в файле.');
  if (data.indexOf(String(oldText), idx + 1) !== -1) {
    throw toolError('old_text_not_unique', 'Фрагмент oldText встречается более одного раза — уточните его.');
  }
  const next = data.slice(0, idx) + String(newText ?? '') + data.slice(idx + String(oldText).length);
  await writeFile(abs, next, 'utf8');
  return { path: rel, edited: true, bytes: Buffer.byteLength(next) };
}

/** write_file (create): создать/перезаписать файл (каталоги создаются). */
export async function writeFileTool({ root, path: rel, content } = {}) {
  requireRoot(root);
  if (!rel) throw toolError('path_required', 'Укажите путь файла (path).');
  const abs = safeResolve(root, rel);
  if (!abs) throw toolError('path_outside_root', 'Путь выходит за пределы проекта.');
  await mkdir(dirname(abs), { recursive: true });
  const body = String(content ?? '');
  await writeFile(abs, body, 'utf8');
  return { path: rel, written: true, bytes: Buffer.byteLength(body) };
}

/** delete_file (delete): удалить файл проекта. */
export async function deleteFileTool({ root, path: rel } = {}) {
  requireRoot(root);
  if (!rel) throw toolError('path_required', 'Укажите путь файла (path).');
  const abs = safeResolve(root, rel);
  if (!abs) throw toolError('path_outside_root', 'Путь выходит за пределы проекта.');
  try {
    await unlink(abs);
  } catch (e) {
    if (e.code === 'ENOENT') throw toolError('not_found', `Файл не найден: ${rel}`);
    if (e.code === 'EISDIR') throw toolError('is_directory', `Это каталог, не файл: ${rel}`);
    throw e;
  }
  return { path: rel, deleted: true };
}

// Реестр исполнителей builtin-инструментов по имени.
export const BUILTIN_TOOLS = {
  read_file: readFileTool,
  list_dir: listDirTool,
  search_text: searchTextTool,
  edit_file: editFileTool,
  write_file: writeFileTool,
  delete_file: deleteFileTool,
};

/** Выполнить builtin-инструмент по имени. Бросает, если имя неизвестно. */
export async function executeBuiltin(name, args = {}) {
  const fn = BUILTIN_TOOLS[name];
  if (!fn) throw toolError('unknown_tool', `Неизвестный инструмент: ${name}`);
  return fn(args);
}

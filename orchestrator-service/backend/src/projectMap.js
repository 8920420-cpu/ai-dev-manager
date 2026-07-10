// RESEARCH-BUDGET-001 — подача КАРТЫ ПРОЕКТА инлайн в контекст рассуждающих ролей.
//
// Зачем: разведка Архитектора/Декомпозитора раздувалась до десятков проходов —
// роль каждый раз ПЕРЕОТКРЫВАЛА структуру проекта широкими Grep/Glob-свипами.
// Модель разведки должна быть двухуровневой и короткой:
//   1) прочесть общую карту проекта (PROJECT_MAP.md/ARCHITECTURE.md);
//   2) прочесть карту затронутого микросервиса;
//   3) затем точечно прочитать только напрямую релевантные файлы.
// Подавая обе карты прямо в промпт, мы убираем шаги 1–2 из tool-loop: роль не
// тратит ходы на «осмотреться». Карты редко меняются, поэтому держим их в
// процессном кэше с TTL (по умолчанию 1 час) — не перечитываем диск на каждый claim.
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Сколько держим карту в кэше, не перечитывая диск. Пользовательская модель —
// «карта живёт в кэше хотя бы час»: структура проекта меняется редко.
const MAP_TTL_MS = Math.max(0, Number(process.env.PROJECT_MAP_TTL_MS || 60 * 60 * 1000));
// Потолок размера ПОЛНОЙ карты в символах: карта — это ориентир, а не весь репозиторий.
// PROMPT-CACHE-001: полную карту получают роли на движках с prompt-кэшем (claude_code:
// карта в кэшируемом system-префиксе). RESEARCH-BUDGET-002: подняли (8000→14000) —
// у claude карта кэшируется, поэтому больший бюджет почти бесплатен (повторные
// прогоны читают её как cache_read), зато Архитектор видит структуру целиком (PROJECT_MAP
// + ARCHITECTURE не обрезаются) и делает МЕНЬШЕ открытий файлов на «осмотреться».
const MAP_MAX_CHARS = Math.max(1000, Number(process.env.PROJECT_MAP_MAX_CHARS || 14000));
// Потолок СОКРАЩЁННОЙ карты (отдельное имя, чтобы не путать с полной): её получают
// движки БЕЗ prompt-кэша (codex) — там карта пересылается на каждый вызов, поэтому
// режем жёстче и приоритетно отдаём карту сервиса (см. variant='short').
const MAP_SHORT_MAX_CHARS = Math.max(500, Number(process.env.PROJECT_MAP_SHORT_MAX_CHARS || 2500));

// key (`${root}::${service}`) -> { at, value }
const cache = new Map();

function clip(text, max = MAP_MAX_CHARS) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…[карта усечена: показано ${max} из ${s.length} символов]`;
}

// Прочитать первый существующий файл из списка кандидатов (относительно root).
// Возвращает { path, content } или null. Пути с кириллицей/пробелами — обычные
// аргументы fs, без шелла, поэтому экранирование не требуется.
async function readFirst(root, candidates) {
  for (const rel of candidates) {
    if (!rel) continue;
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    try {
      const content = await fs.readFile(abs, 'utf8');
      if (content && content.trim()) return { path: rel, content };
    } catch {
      // нет файла / нет доступа — пробуем следующий кандидат
    }
  }
  return null;
}

// Карта уровня проекта: PROJECT_MAP.md (главная) + ARCHITECTURE.md (если есть),
// в бюджете символов. Ищем под корнем проекта и под docs-папкой. В сокращённом
// варианте (short) ARCHITECTURE.md опускаем — оставляем только PROJECT_MAP.md.
async function loadProjectLevel(root, docsPath, maxChars, short = false) {
  const mapDoc = await readFirst(root, [
    docsPath ? path.join(docsPath, 'PROJECT_MAP.md') : null,
    'docs/PROJECT_MAP.md',
    'PROJECT_MAP.md',
  ]);
  const archDoc = short ? null : await readFirst(root, [
    docsPath ? path.join(docsPath, 'ARCHITECTURE.md') : null,
    'docs/ARCHITECTURE.md',
    'ARCHITECTURE.md',
  ]);
  const parts = [];
  if (mapDoc) parts.push(`<!-- ${mapDoc.path} -->\n${clip(mapDoc.content, maxChars)}`);
  if (archDoc) parts.push(`<!-- ${archDoc.path} -->\n${clip(archDoc.content, maxChars)}`);
  return parts.length ? parts.join('\n\n') : '';
}

// RESEARCH-BUDGET-002 — авто-индекс структуры репозитория (когда карт-доков мало).
// Каталоги/шумовые папки, которые в скелет НЕ включаем: они не помогают роли понять
// устройство проекта, только раздувают индекс.
const OUTLINE_SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'vendor', 'target',
  'coverage', '.cache', '.idea', '.vscode', '.next', '.turbo', 'tmp', 'temp', '__pycache__',
]);
// Ключевые файлы уровня корня: по ним видно тип/сборку проекта и точки входа.
const OUTLINE_NOTABLE_FILE = /^(README|ARCHITECTURE|PROJECT_MAP|go\.work|go\.mod|package\.json|pnpm-workspace\.yaml|docker-compose.*\.ya?ml|Makefile|Cargo\.toml|pyproject\.toml|.*\.sln)$/i;
const OUTLINE_MAX_DIRS = Math.max(0, Number(process.env.PROJECT_MAP_OUTLINE_MAX_DIRS || 80));

// Скелет верхнего уровня репозитория: список каталогов (для монорепо это КАТАЛОГ
// СЕРВИСОВ — ровно то, что Архитектору нужно, чтобы отнести задачу к сервису БЕЗ
// Glob-свипа) + ключевые корневые файлы. Одноуровневый и дешёвый (один readdir),
// кэшируется вместе с картами. Пусто → ничего не добавляем (карта-док остаётся).
async function loadStructureOutline(root, maxChars) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return '';
  }
  const dirs = [];
  const files = [];
  for (const e of entries) {
    const name = e.name;
    if (!name || name.startsWith('.')) continue;
    if (e.isDirectory()) {
      if (!OUTLINE_SKIP_DIRS.has(name)) dirs.push(name);
    } else if (e.isFile() && OUTLINE_NOTABLE_FILE.test(name)) {
      files.push(name);
    }
  }
  if (!dirs.length && !files.length) return '';
  dirs.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.localeCompare(b));
  const lines = ['<!-- структура репозитория (авто-индекс верхнего уровня) -->'];
  if (dirs.length) {
    const shownDirs = dirs.slice(0, OUTLINE_MAX_DIRS);
    const more = dirs.length - shownDirs.length;
    lines.push(`Каталоги верхнего уровня (${dirs.length})${more > 0 ? `, показаны первые ${shownDirs.length}` : ''}: ${shownDirs.join(', ')}${more > 0 ? `, …ещё ${more}` : ''}`);
  }
  if (files.length) lines.push(`Ключевые файлы: ${files.join(', ')}`);
  lines.push('Это авто-индекс, а не полная карта: используй его, чтобы отнести задачу к нужному каталогу/сервису без Glob-свипа по корню.');
  return clip(lines.join('\n'), maxChars);
}

// Карта уровня микросервиса: PROJECT_MAP.md внутри каталога сервиса (best-effort
// по принятым в шаблоне раскладкам). Если не нашли — пусто (общая карта остаётся).
async function loadServiceLevel(root, service, maxChars) {
  const s = String(service || '').trim();
  if (!s) return '';
  const doc = await readFirst(root, [
    `${s}/docs/PROJECT_MAP.md`,
    `services/${s}/docs/PROJECT_MAP.md`,
    `docs/${s}/PROJECT_MAP.md`,
    `${s}/PROJECT_MAP.md`,
  ]);
  return doc ? `<!-- ${doc.path} -->\n${clip(doc.content, maxChars)}` : '';
}

/**
 * Прочитать карту проекта и карту микросервиса для контекста роли.
 * @param {string} projectRoot реальный корень проекта (projects.root_path)
 * @param {{service?:string, docsPath?:string, now?:number, variant?:'full'|'short'}} [opts]
 *   variant='short' (движки без prompt-кэша, напр. codex): жёсткий бюджет символов
 *   + приоритет карты сервиса (если она есть — проектную карту опускаем, «капаем до
 *   сервис-карты»). variant='full' (по умолчанию): полная карта.
 * @returns {Promise<{project:string, service:string, serviceName:string}|null>}
 *   null — если корень не задан или ни одной карты не нашлось.
 */
export async function loadProjectMaps(
  projectRoot,
  { service = '', docsPath = '', now = Date.now(), variant = 'full' } = {},
) {
  const root = String(projectRoot || '').trim();
  if (!root) return null;
  const short = variant === 'short';
  const maxChars = short ? MAP_SHORT_MAX_CHARS : MAP_MAX_CHARS;
  // variant в ключе кэша — иначе short/full затирали бы друг друга под одним ключом.
  const key = `${root}::${service || ''}::${variant}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < MAP_TTL_MS) return hit.value;

  // RESEARCH-BUDGET-002: авто-индекс структуры добавляем только в ПОЛНЫЙ вариант
  // (claude — кэшируется, символы почти бесплатны). В short (codex) экономим символы.
  const [project, svc, outline] = await Promise.all([
    loadProjectLevel(root, docsPath, maxChars, short).catch(() => ''),
    loadServiceLevel(root, service, maxChars).catch(() => ''),
    short ? Promise.resolve('') : loadStructureOutline(root, maxChars).catch(() => ''),
  ]);
  // Скелет структуры дописываем к проектной карте (общий уровень): для монорепо это
  // каталог сервисов, который экономит Архитектору проходы «осмотреться» по корню.
  const projectBlock = [project, outline].filter(Boolean).join('\n\n');
  // Сокращённо: если карта сервиса нашлась — отдаём ТОЛЬКО её (капаем до сервис-карты);
  // иначе оставляем короткую карту проекта. Полный вариант отдаёт обе + скелет.
  const serviceName = String(service || '').trim();
  let value = null;
  if (short && svc) value = { project: '', service: svc, serviceName };
  else if (projectBlock || svc) value = { project: projectBlock, service: svc, serviceName };
  cache.set(key, { at: now, value });
  return value;
}

// Для тестов: сбросить кэш карт.
export function _clearProjectMapCache() {
  cache.clear();
}

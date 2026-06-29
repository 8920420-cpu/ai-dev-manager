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
// Потолок размера одной карты в символах: карта — это ориентир, а не весь репозиторий.
const MAP_MAX_CHARS = Math.max(1000, Number(process.env.PROJECT_MAP_MAX_CHARS || 12000));

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
// в бюджете символов. Ищем под корнем проекта и под docs-папкой.
async function loadProjectLevel(root, docsPath) {
  const mapDoc = await readFirst(root, [
    docsPath ? path.join(docsPath, 'PROJECT_MAP.md') : null,
    'docs/PROJECT_MAP.md',
    'PROJECT_MAP.md',
  ]);
  const archDoc = await readFirst(root, [
    docsPath ? path.join(docsPath, 'ARCHITECTURE.md') : null,
    'docs/ARCHITECTURE.md',
    'ARCHITECTURE.md',
  ]);
  const parts = [];
  if (mapDoc) parts.push(`<!-- ${mapDoc.path} -->\n${clip(mapDoc.content)}`);
  if (archDoc) parts.push(`<!-- ${archDoc.path} -->\n${clip(archDoc.content)}`);
  return parts.length ? parts.join('\n\n') : '';
}

// Карта уровня микросервиса: PROJECT_MAP.md внутри каталога сервиса (best-effort
// по принятым в шаблоне раскладкам). Если не нашли — пусто (общая карта остаётся).
async function loadServiceLevel(root, service) {
  const s = String(service || '').trim();
  if (!s) return '';
  const doc = await readFirst(root, [
    `${s}/docs/PROJECT_MAP.md`,
    `services/${s}/docs/PROJECT_MAP.md`,
    `docs/${s}/PROJECT_MAP.md`,
    `${s}/PROJECT_MAP.md`,
  ]);
  return doc ? `<!-- ${doc.path} -->\n${clip(doc.content)}` : '';
}

/**
 * Прочитать карту проекта и карту микросервиса для контекста роли.
 * @param {string} projectRoot реальный корень проекта (projects.root_path)
 * @param {{service?:string, docsPath?:string, now?:number}} [opts]
 * @returns {Promise<{project:string, service:string, serviceName:string}|null>}
 *   null — если корень не задан или ни одной карты не нашлось.
 */
export async function loadProjectMaps(projectRoot, { service = '', docsPath = '', now = Date.now() } = {}) {
  const root = String(projectRoot || '').trim();
  if (!root) return null;
  const key = `${root}::${service || ''}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < MAP_TTL_MS) return hit.value;

  const [project, svc] = await Promise.all([
    loadProjectLevel(root, docsPath).catch(() => ''),
    loadServiceLevel(root, service).catch(() => ''),
  ]);
  const value = project || svc
    ? { project, service: svc, serviceName: String(service || '').trim() }
    : null;
  cache.set(key, { at: now, value });
  return value;
}

// Для тестов: сбросить кэш карт.
export function _clearProjectMapCache() {
  cache.clear();
}

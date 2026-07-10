// SCANNER-INTAKE-001 — импорт задач из Markdown-очередей сервисов tasks/<service>.md в БД.
//
// Очередь сервиса — это один Markdown-файл со списком задач секциями:
//   ### [<маркер>] P<приоритет> <INITIATIVE-ID> — <заголовок>
// и YAML-frontmatter, где задан код сервиса (Scanner их не угадывает):
//   ---
//   service: ORCHESTRATOR
//   ---
//
// Programmer, закончив код и тесты, ставит задаче маркер `[x]`. Scanner находит
// такие секции, отправляет их оркестратору (`POST /api/scanner/task-intake`) и
// ВЫРЕЗАЕТ задачу из файла — дальше она живёт только в БД (REVIEW → … → DONE).
//
// Идемпотентность обеспечивает БД (UNIQUE project_id+external_id): если файл не
// успел очиститься (сбой между отправкой и записью), повторная отправка вернёт
// `duplicate`, после чего секция всё равно вырезается. Локальный state-файл не нужен.
import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Маркер «готово, забрать в БД». Остальные ([ ]/[B]/[~]/[R]/[!]) Scanner пропускает.
const PICK_MARKER = 'x';
// Служебные файлы папки задач, которые не являются очередями.
const SKIP_FILES = new Set(['README.md', 'TASK.template.md']);
// Папки, которые не сканируем (история и служебное состояние).
const SKIP_DIRS = new Set(['archive']);

// Заголовок задачи: ### [<маркер>] P0.1 <ID> — <title>
const TASK_HEADING = /^###\s+\[([^\]]*)\]\s+(P\d+(?:\.\d+)?)\b\s*(.*)$/;
// Граница секции задачи — заголовок 1–3 уровня (файл `#`, раздел `##`, задача
// `###`). Подзаголовки `####`+ и текст с двоеточием остаются телом задачи.
const SECTION_BOUNDARY = /^#{1,3}\s+/;

/** Завершённый ли маркер очереди (`[x]`). */
export function isPickable(marker) {
  return String(marker ?? '').trim().toLocaleLowerCase('ru-RU') === PICK_MARKER;
}

// Разобрать YAML-frontmatter (минимально, нужные ключи). Возвращает { ...поля }.
export function parseFrontmatter(text) {
  const frontmatter = {};
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text ?? ''));
  if (!fm) return frontmatter;
  for (const line of fm[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[kv[1]] = value;
  }
  return frontmatter;
}

// Разобрать строку заголовка задачи в { marker, priority, id, title } или null.
function parseHeading(line) {
  const m = TASK_HEADING.exec(line);
  if (!m) return null;
  const marker = m[1].trim();
  const priority = m[2];
  const rest = m[3].trim();
  // rest = "<ID> — <title>" (em dash) либо просто "<title>".
  const dash = rest.indexOf('—');
  const id = dash >= 0 ? rest.slice(0, dash).trim() : '';
  const title = (dash >= 0 ? rest.slice(dash + 1) : rest).trim();
  return { marker, priority, id, title };
}

/**
 * Разобрать очередь сервиса. Возвращает { service, tasks }, где каждая задача —
 * { marker, priority, id, title, body, startLine, endLine } (границы строк — для
 * последующего вырезания). Чистая функция, покрыта тестами.
 */
export function parseQueueFile(raw) {
  const text = String(raw ?? '');
  const service = String(parseFrontmatter(text).service ?? '').trim();
  const lines = text.split(/\r?\n/);
  const tasks = [];
  for (let i = 0; i < lines.length; i++) {
    const head = parseHeading(lines[i]);
    if (!head) continue;
    let end = i + 1;
    while (end < lines.length && !SECTION_BOUNDARY.test(lines[end])) end++;
    const body = lines.slice(i + 1, end).join('\n').trim();
    tasks.push({ ...head, body, startLine: i, endLine: end });
  }
  return { service, tasks };
}

/**
 * Вырезать задачу с приоритетом `priority` из текста очереди, не трогая остальное.
 * Поглощает предшествующие пустые строки, чтобы не накапливать разрывы. Возвращает
 * исходный текст без изменений, если такой задачи нет. Чистая функция.
 */
export function removeTaskSection(raw, priority) {
  const text = String(raw ?? '');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const { tasks } = parseQueueFile(text);
  const target = tasks.find((t) => t.priority === priority);
  if (!target) return text;
  const lines = text.split(/\r?\n/);
  let start = target.startLine;
  while (start > 0 && lines[start - 1].trim() === '') start--;
  lines.splice(start, target.endLine - start);
  let out = lines.join(eol);
  // Схлопнуть тройные+ переводы строк до одного пустого разделителя.
  out = out.replace(new RegExp(`(?:${eol}){3,}`, 'g'), `${eol}${eol}`);
  if (!out.endsWith(eol)) out += eol;
  return out;
}

// Рекурсивно собрать пути всех *.md в каталоге (кроме служебных файлов/папок).
async function listMarkdown(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      out.push(...(await listMarkdown(full)));
    } else if (entry.isFile() && entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export class TaskIntake {
  /**
   * @param {object} opts
   * @param {string} opts.tasksDir — корень папки очередей (рекурсивный обход).
   * @param {string} opts.project — проект-владелец (code|name|root_path).
   * @param {(payload) => Promise<object>} opts.intake — POST в оркестратор.
   */
  constructor({ tasksDir, project, intake, log = console } = {}) {
    if (!tasksDir) throw new Error('tasksDir is required');
    if (!project) throw new Error('project is required');
    if (typeof intake !== 'function') throw new Error('intake must be a function');
    this.tasksDir = resolve(tasksDir);
    this.project = project;
    this.intake = intake;
    this.log = log;
    this.scanning = false;
  }

  async scanOnce() {
    if (this.scanning) return { skipped: true, reason: 'scan_in_progress' };
    this.scanning = true;
    try {
      const files = await listMarkdown(this.tasksDir);
      const imported = [];
      for (const file of files) {
        let raw;
        try {
          raw = await readFile(file, 'utf8');
        } catch (error) {
          this.log.warn?.('Intake read failed', { file, error: error.message });
          continue;
        }
        const { service, tasks } = parseQueueFile(raw);
        const pickable = tasks.filter((t) => isPickable(t.marker));
        if (!pickable.length) continue;
        if (!service) {
          this.log.warn?.('Intake skipped queue without service frontmatter', { file });
          continue;
        }
        for (const task of pickable) {
          const externalId = `${service}-${task.priority}`;
          try {
            const res = await this.intake({
              externalId,
              project: this.project,
              service,
              title: task.title || externalId,
              description: task.body,
            });
            // Импорт принят (новый или duplicate) — задача теперь в БД, убираем её
            // из файла. Re-read прямо перед записью + atomic rename гасят гонки.
            await this.#removeFromFile(file, task.priority);
            imported.push({
              externalId, file,
              taskId: res?.taskId ?? null,
              duplicate: Boolean(res?.duplicate),
            });
          } catch (error) {
            this.log.error?.('Intake dispatch failed', { file, externalId, error: error.message });
          }
        }
      }
      if (imported.length) this.log.info?.('Intake imported tasks', { count: imported.length });
      return { scanned: files.length, imported };
    } finally {
      this.scanning = false;
    }
  }

  async #removeFromFile(file, priority) {
    const raw = await readFile(file, 'utf8');
    const next = removeTaskSection(raw, priority);
    if (next === raw) return;
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, next, 'utf8');
    await rename(temporary, file);
  }
}

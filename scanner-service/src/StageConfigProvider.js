// Провайдеры конфигурации watcher'ов Scanner.
//
// Источник истины — orchestrator-service. Scanner больше НЕ входит в движение по
// ролям: это отдельная роль‑приёмник, которая следит за «папкой документов»
// проекта (`projects.docs_path`) и принимает оттуда задачи. Поэтому watcher
// строится по `project.docsPath` — по одному на проект с заданной папкой.
// Провайдер возвращает плоский список `{ projectId, stageId, watchDirectory,
// documentName }`, адресуемых по `projectId + stageId`. Документ внутри папки —
// `documentName` (default `claude-tasks.json`); существование папки проверяет
// supervisor, не провайдер.
import { readFile } from 'node:fs/promises';

// Идентификатор watcher'а приёма из папки документов (один на проект).
const DOCS_STAGE_ID = 'docs';
const DEFAULT_DOCUMENT_NAME = 'claude-tasks.json';

/**
 * Преобразовать ответ `GET /api/projects` (rich-список) в список watcher'ов.
 * Берём по одному watcher'у на проект с непустой папкой документов (`docsPath`).
 * Чистая функция — удобно тестировать и переиспользовать для snapshot.
 */
export function stageConfigsFromProjects(projects) {
  const list = Array.isArray(projects) ? projects : [];
  const configs = [];
  for (const project of list) {
    const projectId = project?.id ?? project?.projectId ?? null;
    if (projectId == null) continue;
    // Приём включается тумблером на карточке проекта (scanner_enabled).
    if (project?.scannerEnabled !== true && project?.scanner_enabled !== true) continue;
    const watchDirectory = trimOrNull(project?.docsPath ?? project?.docs_path);
    if (!watchDirectory) continue; // проект без папки документов — без watcher
    configs.push({
      projectId: String(projectId),
      stageId: DOCS_STAGE_ID,
      watchDirectory,
      documentName: trimOrNull(project?.documentName) ?? DEFAULT_DOCUMENT_NAME,
    });
  }
  return configs;
}

function trimOrNull(value) {
  const t = String(value ?? '').trim();
  return t.length ? t : null;
}

/**
 * Провайдер из API оркестратора. Возвращает async-функцию, отдающую актуальный
 * список watcher-конфигов. Сетевые/HTTP-ошибки пробрасываются вызывающему —
 * supervisor сам решает сохранить прежний набор watcher'ов при недоступности API.
 */
export function createApiStageConfigProvider({ projectsEndpoint, token = '', fetchImpl = fetch }) {
  if (!projectsEndpoint) throw new Error('projectsEndpoint is required');
  return async () => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(projectsEndpoint, { method: 'GET', headers });
    const body = await response.text();
    if (!response.ok) throw new Error(`Orchestrator returned ${response.status}: ${body}`);
    const parsed = body ? JSON.parse(body) : {};
    return stageConfigsFromProjects(parsed.projects ?? parsed);
  };
}

/**
 * Провайдер из локального JSON-snapshot — документированный fallback, когда
 * оркестратор недоступен. Формат: либо `{ projects: [...] }` (как ответ API),
 * либо `{ watchers: [{ projectId, stageId, watchDirectory, documentName }] }`.
 */
export function createSnapshotStageConfigProvider({ snapshotPath }) {
  if (!snapshotPath) throw new Error('snapshotPath is required');
  return async () => {
    const raw = await readFile(snapshotPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.watchers)) {
      return parsed.watchers
        .map((w) => ({
          projectId: String(w?.projectId ?? ''),
          stageId: String(w?.stageId ?? ''),
          watchDirectory: trimOrNull(w?.watchDirectory),
          documentName: trimOrNull(w?.documentName) ?? DEFAULT_DOCUMENT_NAME,
        }))
        .filter((w) => w.projectId && w.watchDirectory);
    }
    return stageConfigsFromProjects(parsed?.projects ?? parsed);
  };
}

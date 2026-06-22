// Провайдеры конфигурации watcher'ов Scanner.
//
// Источник истины — orchestrator-service: какие этапы включены и какая у них
// папка наблюдения. Признак Scanner — ВСЕГДА код роли `SCANNER` (P0.1), а не
// отображаемое имя этапа. Провайдер возвращает плоский список желаемых watcher'ов
// `{ projectId, stageId, watchDirectory, documentName }`, адресуемых по
// `projectId + stageId`. Документ внутри папки — `documentName` (default
// `claude-tasks.json`); существование папки проверяет supervisor, не провайдер.
import { readFile } from 'node:fs/promises';

export const SCANNER_ROLE_CODE = 'SCANNER';
const DEFAULT_DOCUMENT_NAME = 'claude-tasks.json';

/**
 * Преобразовать ответ `GET /api/projects` (rich-список) в список watcher'ов.
 * Берём только этапы с ролью SCANNER, enabled !== false и непустой папкой.
 * Чистая функция — удобно тестировать и переиспользовать для snapshot.
 */
export function stageConfigsFromProjects(projects) {
  const list = Array.isArray(projects) ? projects : [];
  const configs = [];
  for (const project of list) {
    const projectId = project?.id ?? project?.projectId ?? null;
    if (projectId == null) continue;
    const stages = Array.isArray(project?.stages) ? project.stages : [];
    for (const stage of stages) {
      const roleCodes = Array.isArray(stage?.roleCodes) ? stage.roleCodes : [];
      if (!roleCodes.includes(SCANNER_ROLE_CODE)) continue;
      if (stage?.enabled === false) continue; // отключённый этап — без watcher
      const watchDirectory = trimOrNull(stage?.scanner?.watchDirectory ?? stage?.watchDirectory);
      if (!watchDirectory) continue; // включённый Scanner без папки — конфиг-ошибка владельца контракта
      configs.push({
        projectId: String(projectId),
        stageId: String(stage?.id ?? ''),
        watchDirectory,
        documentName: trimOrNull(stage?.scanner?.documentName) ?? DEFAULT_DOCUMENT_NAME,
      });
    }
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

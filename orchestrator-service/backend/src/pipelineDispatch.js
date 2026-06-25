// PIPELINE-NON-AI-EXECUTOR-001 (ORCHESTRATOR-P1.3) — контракт прямой передачи
// этапа PIPELINE_SERVICE не-AI исполнителю (pipeline-runner/host worker).
//
// PIPELINE_SERVICE — host-роль, не LLM-роль: claim не создаёт prompt_exchange и
// не выбирает LLM-коннектор. Здесь только ЧИСТАЯ сборка/валидация контракта
// claim (без БД и сети), чтобы покрыть юнит-тестами выбор сервиса, рабочую
// директорию и защиту от выхода за корень проекта (path traversal).

// Имя pipeline-конфигурации по умолчанию (внутри рабочей директории сервиса).
export const PIPELINE_CONFIG_FILENAME = process.env.PIPELINE_CONFIG_FILENAME || '.pipeline.json';

/**
 * Безопасен ли относительный путь сервиса внутри корня проекта:
 * не пустой-абсолютный, без '..'-сегментов и без диск-префикса/ведущего слэша.
 * Пустая строка допустима (сервис в корне проекта).
 */
export function isServicePathSafe(repositoryPath) {
  const raw = String(repositoryPath ?? '').trim().replace(/\\/g, '/');
  if (raw === '') return true;
  if (raw.includes('\0')) return false;
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/')) return false;
  const segments = raw.replace(/^\.\//, '').split('/');
  return !segments.some((s) => s === '..');
}

// POSIX-join без выхода за базу. Возвращает '' для пустых сегментов.
function posixJoin(base, rel) {
  const b = String(base ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const r = String(rel ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!b) return r;
  if (!r) return b;
  return `${b}/${r}`;
}

/**
 * Рабочая директория сервиса = projectRoot + repositoryPath (POSIX).
 * null, если путь сервиса небезопасен или нет projectRoot.
 */
export function resolveWorkingDirectory(projectRoot, repositoryPath) {
  if (!isServicePathSafe(repositoryPath)) return null;
  const root = String(projectRoot ?? '').trim();
  if (!root) return null;
  return posixJoin(root, repositoryPath);
}

/**
 * Собрать контракт claim для PIPELINE_SERVICE. Бросает Error с .code, если
 * микросервис не определён или путь выходит за корень проекта — этап не
 * запускается до выполнения команд (диагностируемая ошибка).
 *
 * Вход (из БД): { projectId, projectCode, serviceId, serviceCode, serviceName,
 *                 projectRoot, repositoryPath }.
 * Выход: стабильный DTO для pipeline-runner/host worker.
 */
export function buildPipelineClaimContract(input) {
  const projectId = String(input?.projectId ?? '').trim();
  const serviceId = String(input?.serviceId ?? '').trim();
  if (!projectId) {
    const e = new Error('pipeline_project_required');
    e.code = 'pipeline_project_required';
    throw e;
  }
  if (!serviceId) {
    // Неизвестный/удалённый сервис — ошибка до запуска команд.
    const e = new Error('pipeline_service_required');
    e.code = 'pipeline_service_required';
    throw e;
  }
  if (!isServicePathSafe(input?.repositoryPath)) {
    const e = new Error('pipeline_service_path_escape');
    e.code = 'pipeline_service_path_escape';
    throw e;
  }
  const workingDirectory = resolveWorkingDirectory(input?.projectRoot, input?.repositoryPath);
  if (!workingDirectory) {
    const e = new Error('pipeline_working_directory_unresolved');
    e.code = 'pipeline_working_directory_unresolved';
    throw e;
  }
  return {
    projectId,
    projectCode: String(input?.projectCode ?? '').trim(),
    serviceId,
    serviceCode: String(input?.serviceCode ?? '').trim(),
    serviceName: String(input?.serviceName ?? input?.serviceCode ?? '').trim(),
    projectRoot: String(input?.projectRoot ?? '').trim(),
    repositoryPath: String(input?.repositoryPath ?? '').trim().replace(/\\/g, '/'),
    workingDirectory,
    pipelineConfigRef: posixJoin(workingDirectory, PIPELINE_CONFIG_FILENAME),
  };
}

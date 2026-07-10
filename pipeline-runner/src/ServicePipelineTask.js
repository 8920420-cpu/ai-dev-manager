import path from 'node:path';
import { existsSync, statSync } from 'node:fs';

import { ConfigLoader } from './ConfigLoader.js';
import { PipelineRunner } from './PipelineRunner.js';
import { ConventionConfigBuilder, ConventionError, mergeConvention } from './ConventionConfigBuilder.js';

/**
 * ServicePipelineTask — слой «сервисного» исполнения этапа PIPELINE_SERVICE
 * (PIPELINE-NON-AI-EXECUTOR-001, P1.2).
 *
 * Это НЕ-AI исполнитель: здесь нет и не может быть обращения к LLM, AI-коннектору,
 * prompt или модели. Сервис определяется ИСКЛЮЧИТЕЛЬНО по устойчивому контракту
 * claim (`task.pipeline`: projectId/serviceId/serviceName/projectRoot/
 * repositoryPath/workingDirectory/pipelineConfigRef), а НЕ по свободному тексту,
 * prompt или текущей директории процесса.
 *
 * Ответственность модуля:
 *  1. Принять claim-DTO от оркестратора и сверить его (serviceId, путь, корень).
 *  2. Разрешить рабочую директорию сервиса относительно АБСОЛЮТНОГО корня
 *     проектов на хосте и обеспечить path isolation: запрет выхода за projectRoot
 *     и запуск pipeline ровно выбранного сервиса.
 *  3. Загрузить .pipeline.json именно выбранного сервиса и выполнить все его
 *     действия штатным PipelineRunner/StageRunner.
 *  4. Вернуть структурированный результат для POST /api/runner/host-task-completed:
 *     { taskId, roleCode:'PIPELINE_SERVICE', success, output:{ summary, failedStage,
 *       startedAt, logPath } }. Переход детерминирован по success (без AI).
 */

export const PIPELINE_ROLE_CODE = 'PIPELINE_SERVICE';

/** Имя pipeline-конфигурации по умолчанию внутри рабочей директории сервиса. */
export const DEFAULT_PIPELINE_CONFIG_FILENAME = '.pipeline.json';

/**
 * Сколько символов лога команды максимально кладём в безопасный фрагмент.
 * Назначение: не передавать неограниченный вывод (и потенциальные секреты/
 * токены) в summary, который уходит оркестратору и сохраняется в БД.
 */
export const SAFE_LOG_FRAGMENT_LIMIT = 2000;

/** Ошибка контракта/изоляции до запуска команд (диагностируемая). */
export class PipelineTaskError extends Error {
  /** @param {string} message @param {string} code машиночитаемый код причины */
  constructor(message, code) {
    super(message);
    this.name = 'PipelineTaskError';
    this.code = code;
  }
}

/**
 * Безопасен ли относительный путь сервиса внутри корня проекта.
 * Зеркалит серверный контракт (pipelineDispatch.isServicePathSafe), чтобы runner
 * НЕ доверял входу слепо, а перепроверял изоляцию у себя (defense in depth).
 * Пустая строка допустима (сервис лежит в корне проекта).
 */
export function isServiceRelPathSafe(repositoryPath) {
  const raw = String(repositoryPath ?? '').trim().replace(/\\/g, '/');
  if (raw === '') return true;
  if (raw.includes('\0')) return false;
  // Абсолютный путь / диск-префикс / ведущий слэш — выход за пределы корня.
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/')) return false;
  const segments = raw.replace(/^\.\//, '').split('/');
  return !segments.some((s) => s === '..');
}

/**
 * Лежит ли разрешённый абсолютный путь child строго внутри (или равен) base.
 * Сравнение по сегментам, чтобы '/proj-evil' не считался внутри '/proj'.
 */
export function isInsideRoot(base, child) {
  const rel = path.relative(base, child);
  // '' => равен корню; '..' в начале или абсолютный путь => снаружи корня.
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Разрешить контракт сервиса в реальные абсолютные пути хоста и проверить
 * изоляцию. Бросает PipelineTaskError ДО запуска команд при любой проблеме.
 *
 * @param {Object} pipeline DTO claim (`task.pipeline`)
 * @param {Object} opts
 * @param {string} opts.projectsRoot АБСОЛЮТНЫЙ корень всех проектов на хосте.
 *        Относительные projectRoot/workingDirectory контракта резолвятся от него.
 * @param {string} [opts.configFilename]
 * @returns {{
 *   projectId:string, serviceId:string, serviceName:string, serviceCode:string,
 *   projectCode:string, repositoryPath:string,
 *   absProjectRoot:string, absWorkingDirectory:string, absConfigPath:string
 * }}
 */
export function resolveServicePaths(pipeline, { projectsRoot, configFilename = DEFAULT_PIPELINE_CONFIG_FILENAME } = {}) {
  if (!pipeline || typeof pipeline !== 'object') {
    throw new PipelineTaskError('Claim не содержит блока pipeline', 'pipeline_contract_missing');
  }
  const root = String(projectsRoot ?? '').trim();
  if (!root || !path.isAbsolute(root)) {
    throw new PipelineTaskError(
      `Требуется абсолютный корень проектов (projectsRoot), получено: ${JSON.stringify(projectsRoot)}`,
      'pipeline_projects_root_required',
    );
  }

  const projectId = String(pipeline.projectId ?? '').trim();
  if (!projectId) {
    throw new PipelineTaskError('Контракт не содержит projectId', 'pipeline_project_required');
  }

  // Сервис определяется по устойчивому serviceId, НЕ по тексту/prompt/CWD.
  const serviceId = String(pipeline.serviceId ?? '').trim();
  if (!serviceId) {
    throw new PipelineTaskError(
      'Неизвестный/удалённый сервис: serviceId отсутствует',
      'pipeline_service_required',
    );
  }

  const projectRootRel = String(pipeline.projectRoot ?? '').trim();
  if (!projectRootRel) {
    throw new PipelineTaskError('Контракт не содержит projectRoot', 'pipeline_working_directory_unresolved');
  }
  const repositoryPath = String(pipeline.repositoryPath ?? '').trim().replace(/\\/g, '/');

  // Изоляция #1: относительный путь сервиса не должен пытаться выйти за корень.
  if (!isServiceRelPathSafe(repositoryPath)) {
    throw new PipelineTaskError(
      `Путь сервиса выходит за корень проекта: ${repositoryPath}`,
      'pipeline_service_path_escape',
    );
  }
  if (!isServiceRelPathSafe(projectRootRel)) {
    throw new PipelineTaskError(
      `projectRoot выходит за корень проектов: ${projectRootRel}`,
      'pipeline_service_path_escape',
    );
  }

  const absProjectRoot = path.resolve(root, projectRootRel);
  const absWorkingDirectory = path.resolve(absProjectRoot, repositoryPath);

  // Изоляция #2 (на реальных путях): рабочая директория сервиса обязана лежать
  // внутри корня проекта — нельзя запускать pipeline соседнего микросервиса и
  // выходить за projectRoot, даже если относительная проверка что-то пропустила
  // (symlink-резолв даёт абсолютные пути, по которым и сверяемся).
  if (!isInsideRoot(absProjectRoot, absWorkingDirectory)) {
    throw new PipelineTaskError(
      `Рабочая директория ${absWorkingDirectory} выходит за корень проекта ${absProjectRoot}`,
      'pipeline_service_path_escape',
    );
  }

  const absConfigPath = path.resolve(absWorkingDirectory, configFilename);
  // Конфиг тоже обязан лежать внутри рабочей директории (а значит и проекта).
  if (!isInsideRoot(absWorkingDirectory, absConfigPath)) {
    throw new PipelineTaskError(
      `Конфиг сервиса ${absConfigPath} вне рабочей директории`,
      'pipeline_service_path_escape',
    );
  }

  return {
    projectId,
    serviceId,
    serviceName: String(pipeline.serviceName ?? pipeline.serviceCode ?? serviceId).trim(),
    serviceCode: String(pipeline.serviceCode ?? '').trim(),
    projectCode: String(pipeline.projectCode ?? '').trim(),
    repositoryPath,
    absProjectRoot,
    absWorkingDirectory,
    absConfigPath,
  };
}

/** Усечь произвольный текст до безопасного фрагмента (без неограниченного вывода). */
export function safeLogFragment(text, limit = SAFE_LOG_FRAGMENT_LIMIT) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n…[усечено ${s.length - limit} символов]`;
}

/**
 * Превратить summary одного этапа (из StageRunner) в структурированные действия:
 * по одному «action» на команду — статус, длительность, exit code и безопасный
 * фрагмент лога. Неограниченный stdout/stderr НЕ кладём (StageRunner его не
 * возвращает покомандно; фрагмент берём из присоединённого фрагмента, если есть).
 */
function stageToActions(stageSummary) {
  if (stageSummary.status === 'SKIPPED') {
    return [
      {
        stage: stageSummary.name,
        name: stageSummary.name,
        status: 'SKIPPED',
        exitCode: null,
        durationMs: 0,
        reason: stageSummary.reason ?? 'disabled_by_configuration',
      },
    ];
  }
  const commands = Array.isArray(stageSummary.commands) ? stageSummary.commands : [];
  return commands.map((c) => ({
    stage: stageSummary.name,
    name: stageSummary.name,
    command: safeLogFragment(c.command, 500),
    status: c.status,
    exitCode: c.exitCode ?? null,
    durationMs: Math.round((c.durationSeconds ?? 0) * 1000),
    timedOut: c.timedOut === true,
    ...(c.error ? { error: safeLogFragment(c.error, 500) } : {}),
    ...(c.logFragment ? { logFragment: safeLogFragment(c.logFragment) } : {}),
  }));
}

/**
 * Собрать верхнеуровневую причину провала (code/message/logTail) из summary
 * упавшей стадии для output.summary.error. Ключевое — logTail: безопасный хвост
 * вывода ИМЕННО упавшей команды. Берётся из уже собранного StageRunner-ом
 * commands[].logFragment (файлы с хоста не читаются) и усекается через
 * safeLogFragment(SAFE_LOG_FRAGMENT_LIMIT). Если хвоста нет (таймаут до запуска
 * команды или команда без вывода) — logTail пустой, а причина отражена в
 * message (reason / exit code), без падения.
 *
 * @param {Object|null} summaryDoc summary из PipelineRunner (result.summary)
 * @param {string|null} failedStage имя упавшей стадии (result.failedStage)
 * @returns {{ code: string, message: string, logTail: string }}
 */
function failureErrorFromSummary(summaryDoc, failedStage) {
  const stages = summaryDoc && Array.isArray(summaryDoc.stages) ? summaryDoc.stages : [];
  const stage =
    stages.find((s) => s.name === failedStage) ??
    stages.find((s) => s.status !== 'success' && s.status !== 'SKIPPED') ??
    null;
  if (!stage) {
    return { code: 'pipeline_failed', message: 'Pipeline провалился', logTail: '' };
  }

  const commands = Array.isArray(stage.commands) ? stage.commands : [];
  // Упавшая команда: по failedCommand, иначе первая с не-success статусом.
  const failed =
    commands.find((c) => c.command === stage.failedCommand) ??
    commands.find((c) => c.status !== 'success') ??
    null;

  const timedOut = failed?.timedOut === true || stage.reason === 'timeout';
  const exitCode = stage.exitCode ?? failed?.exitCode ?? null;
  const cmdText = failed?.command ?? stage.failedCommand ?? null;

  const parts = [`Стадия "${stage.name}" провалилась`];
  if (cmdText) parts.push(`команда: ${safeLogFragment(cmdText, 200)}`);
  if (timedOut) parts.push('причина: timeout');
  else if (exitCode !== null && exitCode !== undefined) parts.push(`exit=${exitCode}`);
  if (failed?.error) parts.push(`error=${safeLogFragment(String(failed.error), 200)}`);

  return {
    code: timedOut ? 'pipeline_stage_timeout' : 'pipeline_stage_failed',
    message: safeLogFragment(parts.join(', '), 1000),
    // Хвост берём из уже возвращённого logFragment упавшей команды и усекаем ещё раз.
    logTail: failed?.logFragment ? safeLogFragment(failed.logFragment) : '',
  };
}

/**
 * ServicePipelineTask — исполнение этапа PIPELINE_SERVICE для одного claim.
 */
export class ServicePipelineTask {
  /**
   * @param {Object} opts
   * @param {string} opts.projectsRoot АБСОЛЮТНЫЙ корень проектов на хосте.
   * @param {string} [opts.configFilename]
   * @param {ConfigLoader} [opts.configLoader]
   * @param {(args:{config:Object})=>{execute:Function}} [opts.createRunner] фабрика runner (для тестов)
   * @param {Object} [opts.runnerDeps] зависимости PipelineRunner (executor/logger) для тестов
   */
  constructor({ projectsRoot, configFilename = DEFAULT_PIPELINE_CONFIG_FILENAME, configLoader, conventionBuilder, createRunner, runnerDeps } = {}) {
    this.projectsRoot = projectsRoot;
    this.configFilename = configFilename;
    this.configLoader = configLoader ?? new ConfigLoader();
    this.conventionBuilder = conventionBuilder ?? new ConventionConfigBuilder();
    this.runnerDeps = runnerDeps ?? {};
    this.createRunner =
      createRunner ?? ((args) => new PipelineRunner({ ...args, ...this.runnerDeps }));
  }

  /**
   * Выполнить этап PIPELINE_SERVICE по claim-задаче оркестратора.
   * AI не участвует ни на одном шаге.
   *
   * @param {Object} task claim из GET /api/runner/next-host-task
   * @returns {Promise<{ taskId:string, roleCode:string, success:boolean, output:Object }>}
   */
  async run(task) {
    const startedAt = new Date();
    const taskId = String(task?.id ?? '').trim() || null;

    let resolved;
    try {
      resolved = resolveServicePaths(task?.pipeline, {
        projectsRoot: this.projectsRoot,
        configFilename: this.configFilename,
      });
    } catch (err) {
      // Диагностируемая ошибка ДО запуска команд: ни одна команда не стартовала.
      return this.#failure({
        taskId,
        startedAt,
        identity: identityFromPipeline(task?.pipeline),
        failedStage: null,
        error: err,
      });
    }

    // Локальный .pipeline.json НЕОБЯЗАТЕЛЕН: если его нет — движок собирает стадии
    // по конвенции монорепо (ConventionConfigBuilder). Если есть — он переопределяет
    // конвенцию: целиком (по умолчанию) либо постадийно (extendsConvention:true).
    const hasLocalConfig =
      existsSync(resolved.absConfigPath) && statSync(resolved.absConfigPath).isFile();

    let config;
    try {
      if (hasLocalConfig) {
        const local = await this.configLoader.load(resolved.absConfigPath);
        config = local.extendsConvention
          ? mergeConvention(this.#buildConvention(resolved), local)
          : local; // полное переопределение конвенции локальным конфигом
      } else {
        config = this.#buildConvention(resolved);
      }
    } catch (err) {
      return this.#failure({
        taskId,
        startedAt,
        identity: resolved,
        // Отсутствие compose (подсистемы) — диагностируемая ошибка стадии deploy.
        failedStage:
          err instanceof ConventionError && err.code === 'pipeline_compose_not_found'
            ? 'deploy'
            : null,
        error: err,
      });
    }

    // Жёстко фиксируем рабочую директорию по контракту: даже если в .pipeline.json
    // указан свой workingDirectory, мы НЕ позволяем выйти за корень проекта.
    if (!isInsideRoot(resolved.absProjectRoot, config.workingDirectory)) {
      return this.#failure({
        taskId,
        startedAt,
        identity: resolved,
        failedStage: null,
        error: new PipelineTaskError(
          `workingDirectory конфига (${config.workingDirectory}) выходит за корень проекта ${resolved.absProjectRoot}`,
          'pipeline_service_path_escape',
        ),
      });
    }

    // Запуск всех объявленных действий штатным PipelineRunner/StageRunner.
    const runner = this.createRunner({ config });
    const result = await runner.execute();

    const summaryDoc = result.summary ?? null;
    const actions = summaryDoc && Array.isArray(summaryDoc.stages)
      ? summaryDoc.stages.flatMap(stageToActions)
      : [];

    const output = {
      summary: {
        projectId: resolved.projectId,
        projectCode: resolved.projectCode,
        serviceId: resolved.serviceId,
        serviceCode: resolved.serviceCode,
        serviceName: resolved.serviceName,
        workingDirectory: resolved.absWorkingDirectory,
        status: result.success ? 'success' : 'failed',
        runId: result.runId ?? null,
        actions,
        // При провале дублируем причину на верхний уровень: усечённый хвост лога
        // ИМЕННО упавшей команды (без чтения файлов с хоста), чтобы Failure
        // Analyst/UI видели фактическую причину, не разбирая actions[] и не
        // читая logPath (путь на хосте им недоступен).
        ...(result.success
          ? {}
          : { error: failureErrorFromSummary(summaryDoc, result.failedStage ?? null) }),
      },
      failedStage: result.failedStage ?? null,
      startedAt: startedAt.toISOString(),
      logPath: result.reportPath ?? null,
    };

    return {
      taskId,
      roleCode: PIPELINE_ROLE_CODE,
      success: result.success === true,
      output,
    };
  }

  /**
   * Построить конфиг по конвенции монорепо для выбранного сервиса.
   * workingDirectory и граница изоляции (projectRoot) берутся из resolved —
   * поиск compose не выходит за корень проекта.
   */
  #buildConvention(resolved) {
    return this.conventionBuilder.build({
      serviceDir: resolved.absWorkingDirectory,
      projectRoot: resolved.absProjectRoot,
      name: resolved.serviceName || resolved.serviceCode || undefined,
    });
  }

  /** Собрать failure-результат с диагностируемой причиной до/во время запуска. */
  #failure({ taskId, startedAt, identity, failedStage, error }) {
    return {
      taskId,
      roleCode: PIPELINE_ROLE_CODE,
      success: false,
      output: {
        summary: {
          projectId: identity?.projectId ?? null,
          projectCode: identity?.projectCode ?? null,
          serviceId: identity?.serviceId ?? null,
          serviceCode: identity?.serviceCode ?? null,
          serviceName: identity?.serviceName ?? null,
          status: 'failed',
          actions: [],
          error: {
            code: error?.code ?? 'pipeline_failed',
            message: safeLogFragment(error?.message ?? String(error), 1000),
          },
        },
        failedStage: failedStage ?? null,
        startedAt: startedAt.toISOString(),
        logPath: null,
      },
    };
  }
}

/** Извлечь идентичность сервиса из (возможно невалидного) контракта для отчёта. */
function identityFromPipeline(pipeline) {
  if (!pipeline || typeof pipeline !== 'object') return null;
  return {
    projectId: pipeline.projectId ? String(pipeline.projectId) : null,
    projectCode: pipeline.projectCode ? String(pipeline.projectCode) : null,
    serviceId: pipeline.serviceId ? String(pipeline.serviceId) : null,
    serviceCode: pipeline.serviceCode ? String(pipeline.serviceCode) : null,
    serviceName: pipeline.serviceName ? String(pipeline.serviceName) : null,
  };
}

/**
 * Удобная функция-обёртка: выполнить этап PIPELINE_SERVICE по claim.
 * @param {Object} task
 * @param {Object} opts см. конструктор ServicePipelineTask
 */
export async function runServicePipeline(task, opts = {}) {
  return new ServicePipelineTask(opts).run(task);
}

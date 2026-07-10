import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { runPipeline } from '../../pipeline-runner/src/index.js';

/**
 * TesterService — ядро роли «Тестировщик (Pipeline Service)».
 *
 * Это исключительно технический исполнитель проверки задачи:
 *  - проверяет наличие .pipeline.json;
 *  - запускает Pipeline Runner;
 *  - дожидается завершения всех этапов;
 *  - получает статус, summary.json и pipeline.log;
 *  - сохраняет результаты выполнения;
 *  - возвращает результат оркестратору.
 *
 * Сервис НЕ анализирует код, НЕ анализирует ошибки, НЕ исправляет проблемы,
 * НЕ даёт рекомендаций и НЕ пропускает этапы Pipeline. Поля summary/logPath
 * в случае ошибки — это сырые артефакты для роли «Failure Analyst», а не разбор.
 */
export class TesterService {
  /**
   * @param {Object} [opts]
   * @param {(args: {configPath: string}) => Promise<Object>} [opts.runPipeline]
   *        фабрика запуска pipeline (переопределяется в тестах)
   * @param {(message: string, meta?: Object) => void} [opts.log] логгер
   * @param {string} [opts.cwd] базовый каталог для разрешения относительных путей
   */
  /**
   * @param {string} [opts.workspaceRoot] корневой каталог, за пределы которого
   *        запрещено выходить projectPath/pipelineConfigPath. По умолчанию берётся
   *        из TESTER_WORKSPACE_ROOT; если не задан — ограничение выключено.
   */
  constructor({ runPipeline: runPipelineFn, log, cwd, workspaceRoot } = {}) {
    this.runPipeline = runPipelineFn ?? runPipeline;
    this.log = log ?? (() => {});
    this.cwd = cwd ?? process.cwd();
    const root = workspaceRoot ?? process.env.TESTER_WORKSPACE_ROOT;
    this.workspaceRoot = root ? path.resolve(root) : null;
  }

  /**
   * Выполнить проверку одной задачи.
   *
   * @param {Object} input
   * @param {string} input.taskId            идентификатор задачи
   * @param {string} input.projectPath       путь к проекту
   * @param {string} [input.pipelineConfigPath] путь к .pipeline.json
   *        (по умолчанию <projectPath>/.pipeline.json)
   * @param {string[]} [input.changedFiles]  список изменённых файлов (только прокидывается)
   * @param {string} [input.programmerComment] комментарий программиста (только прокидывается)
   * @returns {Promise<Object>} результат для оркестратора
   */
  async runCheck(input) {
    const ctx = this.#normalizeInput(input);
    this.log('Проверка задачи запущена', { taskId: ctx.taskId, configPath: ctx.configPath });

    // 1. Проверить наличие .pipeline.json.
    if (!(await pathExists(ctx.configPath))) {
      return this.#finish(ctx, {
        status: 'error',
        taskId: ctx.taskId,
        reason: 'pipeline_config_not_found',
        message: `Файл .pipeline.json не найден: ${ctx.configPath}`,
      });
    }

    // 2-4. Запустить Pipeline Runner и дождаться завершения всех этапов.
    let pipelineResult;
    try {
      pipelineResult = await this.runPipeline({ configPath: ctx.configPath });
    } catch (err) {
      // Сбой запуска/оркестрации (например, некорректный конфиг) до прохода этапов.
      return this.#finish(ctx, {
        status: 'error',
        taskId: ctx.taskId,
        reason: 'pipeline_runner_error',
        message: String(err?.message ?? err),
      });
    }

    const reportDir = path.resolve(this.cwd, pipelineResult.reportPath);
    const summaryPath = path.join(reportDir, 'summary.json');
    const logPath = path.join(reportDir, 'pipeline.log');

    // 5-6. Сформировать результат для оркестратора.
    if (pipelineResult.success) {
      return this.#finish(ctx, {
        status: 'success',
        nextRole: 'Documentation Auditor',
        taskId: ctx.taskId,
        runId: pipelineResult.runId,
        summaryPath,
        logPath,
      });
    }

    return this.#finish(ctx, {
      status: 'failed',
      nextRole: 'Failure Analyst',
      taskId: ctx.taskId,
      runId: pipelineResult.runId,
      summary: await readSummaryText(summaryPath, pipelineResult.failedStage),
      summaryPath,
      logPath,
      failedStage: pipelineResult.failedStage,
    });
  }

  /** Нормализация и валидация входных данных. */
  #normalizeInput(input) {
    if (!input || typeof input !== 'object') {
      throw new TesterInputError('Ожидался объект с входными данными');
    }
    const taskId = req(input.taskId, 'taskId');
    const projectPath = req(input.projectPath, 'projectPath');

    const absProject = path.resolve(this.cwd, projectPath);
    const configPath = input.pipelineConfigPath
      ? path.resolve(this.cwd, input.pipelineConfigPath)
      : path.join(absProject, '.pipeline.json');

    // Защита от выхода за пределы разрешённого рабочего каталога: без неё
    // вызывающий мог бы запустить pipeline и читать результаты в любом месте ФС.
    this.#assertWithinWorkspace(absProject, 'projectPath');
    this.#assertWithinWorkspace(configPath, 'pipelineConfigPath');

    return {
      taskId,
      projectPath: absProject,
      configPath,
      // changedFiles и programmerComment не используются для анализа —
      // только сохраняются в записи результата для аудита/следующих ролей.
      changedFiles: Array.isArray(input.changedFiles) ? input.changedFiles : [],
      programmerComment:
        typeof input.programmerComment === 'string' ? input.programmerComment : '',
    };
  }

  /** Убедиться, что путь не выходит за пределы workspaceRoot (если он задан). */
  #assertWithinWorkspace(absPath, field) {
    if (!this.workspaceRoot) return;
    if (!isWithin(this.workspaceRoot, absPath)) {
      throw new TesterInputError(
        `Поле "${field}" указывает за пределы рабочего каталога: ${absPath}`
      );
    }
  }

  /** Сохранить результаты выполнения и вернуть результат оркестратору. */
  async #finish(ctx, result) {
    const record = {
      ...result,
      input: {
        taskId: ctx.taskId,
        projectPath: ctx.projectPath,
        configPath: ctx.configPath,
        changedFiles: ctx.changedFiles,
        programmerComment: ctx.programmerComment,
      },
    };
    try {
      result.resultPath = await this.#saveResult(ctx, record);
    } catch (err) {
      this.log('Не удалось сохранить результаты выполнения', { error: String(err?.message ?? err) });
    }
    this.log('Проверка задачи завершена', { taskId: ctx.taskId, status: result.status });
    return result;
  }

  /** Запись результата в <projectPath>/.tmp/tester-results/<taskId>.json. */
  async #saveResult(ctx, record) {
    const resultsDir = path.join(ctx.projectPath, '.tmp', 'tester-results');
    await mkdir(resultsDir, { recursive: true });
    const file = path.join(resultsDir, `${sanitizeId(ctx.taskId)}.json`);
    await writeFile(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
    return file;
  }
}

/** Ошибка входных данных — отличается от ошибок выполнения pipeline. */
export class TesterInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TesterInputError';
  }
}

function req(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TesterInputError(`Поле "${name}" обязательно и должно быть непустой строкой`);
  }
  return value.trim();
}

/**
 * Находится ли target внутри root (или совпадает с ним). Сравнение по
 * нормализованным абсолютным путям через path.relative — устойчиво к "..",
 * избыточным разделителям и регистру диска на Windows.
 */
function isWithin(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function pathExists(p) {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Краткая фактическая выжимка из summary.json — БЕЗ анализа причин.
 * Если summary.json недоступен, возвращается минимальная констатация факта.
 */
async function readSummaryText(summaryPath, failedStage) {
  try {
    const raw = await readFile(summaryPath, 'utf8');
    const json = JSON.parse(raw);
    const total = Array.isArray(json.stages) ? json.stages.length : 0;
    return (
      `Pipeline "${json.name ?? 'pipeline'}" завершился со статусом ${json.status ?? 'failed'} ` +
      `на этапе "${failedStage ?? json.failedStage ?? '?'}" ` +
      `(выполнено этапов: ${total}, длительность: ${json.durationSeconds ?? '?'}s).`
    );
  } catch {
    return `Pipeline завершился ошибкой на этапе "${failedStage ?? '?'}".`;
  }
}

/** Безопасное имя файла из идентификатора задачи. */
function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200) || 'task';
}

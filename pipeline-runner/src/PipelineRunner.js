import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { CommandExecutor } from './CommandExecutor.js';
import { StageRunner } from './StageRunner.js';
import { ResultWriter } from './ResultWriter.js';
import { Logger } from './Logger.js';
import { makeRunId, round, toReturnPath } from './util.js';

/**
 * PipelineRunner — оркестрация одного запуска pipeline:
 *  - создаёт изолированный каталог результатов;
 *  - выполняет этапы СТРОГО в порядке из конфига;
 *  - останавливается на первом упавшем этапе;
 *  - пишет summary.json и возвращает результат для внешней системы.
 *
 * Параллельная безопасность: каждый запуск получает уникальный каталог
 * .tmp/pipeline-results/<runId>; глобальные файлы и блокировки не используются,
 * поэтому несколько Runner'ов можно запускать одновременно.
 */
export class PipelineRunner {
  /**
   * @param {Object} opts
   * @param {import('./ConfigLoader.js').NormalizedConfig} opts.config
   * @param {CommandExecutor} [opts.executor]
   * @param {ResultWriter} [opts.resultWriter]
   * @param {(logPath: string) => Logger} [opts.createLogger] фабрика логгера (для тестов)
   */
  constructor({ config, executor, resultWriter, createLogger } = {}) {
    if (!config) throw new Error('PipelineRunner: требуется config');
    this.config = config;
    this.executor = executor ?? new CommandExecutor();
    this.resultWriter = resultWriter ?? new ResultWriter();
    this.createLogger = createLogger ?? ((logPath) => new Logger(logPath));
  }

  async execute() {
    const { config } = this;

    const baseDir = path.join(config.workingDirectory, '.tmp', 'pipeline-results');
    const { runId, reportDir } = reserveRunDir(baseDir, makeRunId());

    const logger = this.createLogger(path.join(reportDir, 'pipeline.log'));
    const stageRunner = new StageRunner({ executor: this.executor, logger });

    const startedAt = new Date();
    logger.info(`Pipeline "${config.name}" started (runId=${runId})`);
    logger.info(`Working directory: ${config.workingDirectory}`);
    logger.info(`Config: ${config.configPath}`);

    const deadline = config.timeoutMinutes
      ? startedAt.getTime() + config.timeoutMinutes * 60_000
      : null;
    const env = { ...process.env };

    const stages = [];
    let failedStage = null;

    for (const stage of config.stages) {
      // Отключённый этап не передаём в StageRunner и не запускаем процессы:
      // фиксируем его на исходной позиции как SKIPPED и идём дальше. Это не
      // ошибка — fail-fast включённых этапов не затрагивается.
      if (stage.enabled === false) {
        // Причина по умолчанию — «отключён конфигом»; конвенция может передать
        // более точную пометку (например, no_tests_detected / no_healthcheck_in_compose).
        const reason = stage.reason ?? 'disabled_by_configuration';
        logger.info(`=== Этап "${stage.name}" пропущен: ${reason} ===`);
        stages.push({
          name: stage.name,
          status: 'SKIPPED',
          durationSeconds: 0,
          reason,
          commands: [],
        });
        continue;
      }

      const summary = await stageRunner.run(stage, {
        cwd: config.workingDirectory,
        env,
        deadline,
      });
      stages.push(summary);
      if (summary.status !== 'success') {
        failedStage = stage.name;
        break; // последующие этапы не запускаются (в т.ч. ещё не достигнутые отключённые)
      }
    }

    const finishedAt = new Date();
    const status = failedStage ? 'failed' : 'success';

    const summary = {
      status,
      name: config.name,
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationSeconds: round((finishedAt.getTime() - startedAt.getTime()) / 1000, 2),
      workingDirectory: config.workingDirectory,
      configPath: config.configPath,
      ...(failedStage ? { failedStage } : {}),
      stages,
    };

    await this.resultWriter.write(reportDir, summary);
    logger.info(`Pipeline finished with status=${status}`);
    await logger.close();

    const reportPath = toReturnPath(reportDir);
    // summary возвращаем всегда: сервисный слой (ServicePipelineTask) строит из
    // него структурированный результат для оркестратора. Поле дополнительно к
    // прежнему контракту — обратная совместимость сохранена.
    return status === 'success'
      ? { success: true, runId, reportPath, summary }
      : { success: false, failedStage, runId, reportPath, summary };
  }
}

/**
 * Атомарно резервирует уникальный каталог запуска.
 * При коллизии (тот же runId в ту же секунду) добавляет суффикс -1, -2, ...
 * Используется mkdir без recursive для атомарной проверки «занято/свободно».
 */
function reserveRunDir(baseDir, baseRunId) {
  mkdirSync(baseDir, { recursive: true });
  let candidate = baseRunId;
  let i = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const dir = path.join(baseDir, candidate);
    try {
      mkdirSync(dir); // упадёт с EEXIST, если каталог уже существует
      return { runId: candidate, reportDir: dir };
    } catch (err) {
      if (err.code === 'EEXIST') {
        candidate = `${baseRunId}-${i++}`;
        continue;
      }
      throw err;
    }
  }
}

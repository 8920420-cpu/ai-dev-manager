import { round } from './util.js';

/**
 * StageRunner — единственная ответственность: выполнить ОДИН этап,
 * то есть последовательно прогнать его команды и остановиться на первой ошибке.
 */
export class StageRunner {
  /**
   * @param {Object} deps
   * @param {import('./CommandExecutor.js').CommandExecutor} deps.executor
   * @param {import('./Logger.js').Logger} deps.logger
   */
  constructor({ executor, logger }) {
    this.executor = executor;
    this.logger = logger;
  }

  /**
   * @param {{name: string, commands: string[]}} stage
   * @param {{cwd: string, env: Object, deadline: number|null}} ctx
   * @returns {Promise<StageSummary>}
   */
  async run(stage, ctx) {
    const t0 = Date.now();
    this.logger.info(`=== Этап "${stage.name}" начат: команд ${stage.commands.length} ===`);

    const commands = [];
    let status = 'success';
    let exitCode = 0;
    let failedCommand = null;
    let reason;

    for (const command of stage.commands) {
      // Общий бюджет времени pipeline транслируется в таймаут каждой команды.
      const timeoutMs = ctx.deadline ? ctx.deadline - Date.now() : undefined;
      if (ctx.deadline && timeoutMs <= 0) {
        this.logger.error(`Достигнут таймаут pipeline до запуска команды: ${command}`);
        commands.push({ command, status: 'timeout', exitCode: null, durationSeconds: 0, timedOut: true });
        status = 'failed';
        reason = 'timeout';
        failedCommand = command;
        exitCode = null;
        break;
      }

      this.logger.info(`$ ${command}`);
      const res = await this.executor.run(command, {
        cwd: ctx.cwd,
        env: ctx.env,
        timeoutMs,
        onStdout: (s) => this.logger.raw(s),
        onStderr: (s) => this.logger.raw(s),
      });

      const ok = res.exitCode === 0 && !res.timedOut && !res.error;
      this.logger.info(
        `-> exit=${res.exitCode} duration=${res.durationSeconds}s` +
          (res.timedOut ? ' [TIMEOUT]' : '') +
          (res.error ? ` error=${res.error}` : ''),
      );

      commands.push({
        command,
        status: ok ? 'success' : res.timedOut ? 'timeout' : 'failed',
        exitCode: res.exitCode,
        durationSeconds: res.durationSeconds,
        timedOut: res.timedOut,
        ...(res.error ? { error: res.error } : {}),
      });

      if (!ok) {
        status = 'failed';
        exitCode = res.exitCode;
        failedCommand = command;
        if (res.timedOut) reason = 'timeout';
        else if (res.error) reason = res.error;
        break; // следующие команды этапа не запускаем
      }
    }

    const durationSeconds = round((Date.now() - t0) / 1000, 2);
    this.logger.info(`=== Этап "${stage.name}" -> ${status} за ${durationSeconds}s ===`);

    /** @type {StageSummary} */
    const summary = { name: stage.name, status, durationSeconds };
    if (status !== 'success') {
      summary.exitCode = exitCode;
      summary.failedCommand = failedCommand;
      if (reason) summary.reason = reason;
    }
    summary.commands = commands;
    return summary;
  }
}

/**
 * @typedef {Object} StageSummary
 * @property {string} name
 * @property {'success'|'failed'} status
 * @property {number} durationSeconds
 * @property {number|null} [exitCode]
 * @property {string} [failedCommand]
 * @property {string} [reason]
 * @property {Array<Object>} commands
 */

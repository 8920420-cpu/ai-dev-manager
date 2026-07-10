import { spawn } from 'node:child_process';
import process from 'node:process';
import { round } from './util.js';

/**
 * CommandExecutor — единственная ответственность: запустить ОДНУ команду,
 * дождаться завершения и вернуть полный результат (stdout, stderr, код выхода,
 * длительность, признак таймаута).
 *
 * Команда запускается через системную оболочку (cmd.exe / /bin/sh), поэтому
 * поддерживаются любые строки вида "go test ./...", "docker compose up -d" и т.п.
 * Никаких допущений о языке или инструментах не делается.
 */
export class CommandExecutor {
  /**
   * @param {string} command строка команды
   * @param {Object} [opts]
   * @param {string} [opts.cwd] рабочий каталог
   * @param {Object} [opts.env] переменные окружения
   * @param {number} [opts.timeoutMs] таймаут в мс (>0 — включает kill по таймауту)
   * @param {(chunk: string) => void} [opts.onStdout]
   * @param {(chunk: string) => void} [opts.onStderr]
   * @returns {Promise<CommandResult>}
   */
  run(command, { cwd, env, timeoutMs, onStdout, onStderr } = {}) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const child = spawn(command, {
        cwd,
        env: env ?? process.env,
        shell: true,
        windowsHide: true,
        // На POSIX создаём отдельную группу процессов, чтобы по таймауту
        // убить весь поддерево (оболочку и её потомков).
        detached: process.platform !== 'win32',
      });

      let timer = null;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
          finalize(null, 'SIGKILL', null);
        }, timeoutMs);
      }

      child.stdout?.on('data', (d) => {
        const s = d.toString();
        stdout += s;
        onStdout?.(s);
      });
      child.stderr?.on('data', (d) => {
        const s = d.toString();
        stderr += s;
        onStderr?.(s);
      });

      const finalize = (exitCode, signal, spawnError) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({
          command,
          exitCode: exitCode ?? null,
          signal: signal ?? null,
          stdout,
          stderr,
          timedOut,
          error: spawnError ? String(spawnError.message || spawnError) : null,
          durationSeconds: round((Date.now() - startedAt) / 1000, 3),
        });
      };

      child.on('error', (err) => finalize(null, null, err));
      child.on('close', (code, signal) => finalize(code, signal, null));
    });
  }
}

/** Кроссплатформенное завершение процесса и его дочерних процессов. */
function killTree(child) {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      child.kill('SIGKILL');
    } catch {
      /* process may already be gone */
    }
    // taskkill /T убивает всё дерево процессов.
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      // Отрицательный pid = вся группа процессов (см. detached: true).
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* процесс уже завершился */
      }
    }
  }
}

/**
 * @typedef {Object} CommandResult
 * @property {string} command
 * @property {number|null} exitCode
 * @property {string|null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 * @property {string|null} error ошибка запуска процесса (не путать с ненулевым кодом)
 * @property {number} durationSeconds
 */

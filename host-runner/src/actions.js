// Реальные действия host-ролей на хосте (есть docker/git/репозиторий).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { ConfigLoader, PipelineRunner } from '../../pipeline-runner/src/index.js';

const pexec = promisify(execFile);

/**
 * PIPELINE_SERVICE: реальный прогон pipeline через pipeline-runner.
 * По умолчанию — безопасный прогон юнит-тестов pipeline-runner (реальный
 * pass/fail, без docker). Можно указать настоящий .pipeline.json через
 * HOST_PIPELINE_CONFIG (тогда выполняются его стадии, в т.ч. docker build/up).
 */
export async function runPipelineAction(task, opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const configPath = opts.configPath ?? process.env.HOST_PIPELINE_CONFIG ?? '';
  const loader = new ConfigLoader();

  let config;
  if (configPath) {
    config = await loader.load(configPath);
  } else {
    // Безопасный дефолт: гоняем тесты pipeline-runner — реальный прогон без docker.
    const dir = opts.pipelineDir ?? process.env.HOST_PIPELINE_DIR ?? path.join(repoRoot, 'pipeline-runner');
    const cmd = opts.pipelineCmd ?? process.env.HOST_PIPELINE_CMD ?? 'node --test';
    config = loader.validate(
      { name: task.service || 'host-pipeline', workingDirectory: dir, timeoutMinutes: 15, stages: { 'unit-tests': [cmd] } },
      path.join(dir, '.pipeline.json'),
    );
  }

  const result = await new PipelineRunner({ config }).execute();
  return {
    success: result.success === true,
    output: {
      runId: result.runId,
      failedStage: result.failedStage ?? null,
      logPath: result.reportPath ?? null,
      summary: { success: result.success, failedStage: result.failedStage ?? null, runId: result.runId },
    },
  };
}

async function git(repoRoot, args) {
  return pexec('git', ['-C', repoRoot, ...args], { maxBuffer: 8 << 20 });
}

/**
 * GIT_INTEGRATOR: добавить ТОЛЬКО файлы текущей задачи и сделать один локальный
 * коммит. Без push, reset, clean и --no-verify (как требует роль git-integrator).
 */
export async function runGitAction(task, opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const files = (task.changedFiles ?? []).filter(
    (f) => typeof f === 'string' && f.trim() !== '' && !f.includes('..') && !path.isAbsolute(f),
  );
  if (files.length === 0) {
    return { success: true, output: { commit: null, files: [], note: 'no_changed_files' } };
  }

  await git(repoRoot, ['add', '--', ...files]);
  const staged = await git(repoRoot, ['diff', '--cached', '--name-only']);
  const stagedFiles = staged.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (stagedFiles.length === 0) {
    return { success: true, output: { commit: null, files: [], note: 'nothing_staged' } };
  }

  const message =
    `${task.title} (task ${task.id})\n\n` +
    `${task.programmerResult || ''}\n\n` +
    'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>';

  try {
    await git(repoRoot, ['commit', '-m', message]);
  } catch (error) {
    return { success: false, output: { error: `commit failed: ${error.stderr || error.message}`, files: stagedFiles } };
  }

  const head = await git(repoRoot, ['rev-parse', 'HEAD']);
  const branch = await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: '' }));
  return {
    success: true,
    output: { commit: head.stdout.trim(), branch: branch.stdout.trim(), files: stagedFiles, pushed: false },
  };
}

export const EXECUTORS = {
  PIPELINE_SERVICE: runPipelineAction,
  GIT_INTEGRATOR: runGitAction,
};

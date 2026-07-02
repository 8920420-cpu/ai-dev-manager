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
      {
        name: task.service || 'host-pipeline',
        workingDirectory: dir,
        timeoutMinutes: 15,
        stages: { 'unit-tests': { commands: [cmd], enabled: true } },
      },
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

// Гарантировать, что репозиторий существует: если каталог ещё не git-репо —
// инициализировать его и задать минимальную identity, иначе commit упадёт.
// Так GIT_INTEGRATOR самодостаточен: ему не нужен заранее созданный репозиторий.
async function ensureRepo(repoRoot) {
  try {
    await git(repoRoot, ['rev-parse', '--is-inside-work-tree']);
    return { created: false };
  } catch {
    // не репозиторий — инициализируем ниже
  }
  await git(repoRoot, ['init']);
  const email = await git(repoRoot, ['config', 'user.email']).catch(() => ({ stdout: '' }));
  if (!String(email.stdout).trim()) {
    await git(repoRoot, ['config', 'user.email', process.env.GIT_AUTHOR_EMAIL || 'ai-dev-manager@local']);
    await git(repoRoot, ['config', 'user.name', process.env.GIT_AUTHOR_NAME || 'AI Dev Manager']);
  }
  await git(repoRoot, ['config', 'commit.gpgsign', 'false']).catch(() => {});
  return { created: true };
}

/**
 * GIT_INTEGRATOR: добавить ТОЛЬКО файлы текущей задачи, сделать один локальный
 * коммит и запушить в origin (best-effort). Без reset, clean и --no-verify.
 * Название и описание коммита берутся из карточки Приёмщика задач: task.title —
 * короткое название (short_title), task.description — структурированное описание.
 * Всё чистым кодом, без ИИ.
 */
export async function runGitAction(task, opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const files = (task.changedFiles ?? []).filter(
    (f) => typeof f === 'string' && f.trim() !== '' && !f.includes('..') && !path.isAbsolute(f),
  );
  if (files.length === 0) {
    return { success: true, output: { commit: null, files: [], note: 'no_changed_files' } };
  }

  // Репозиторий может быть ещё не создан — инициализируем автоматически.
  const repo = await ensureRepo(repoRoot);

  // Стейджим только те пути задачи, которые git реально видит как изменение
  // (модификация / добавление / удаление). Путь, которого git не знает вовсе
  // (уже закоммичен ранее, либо никогда не существовал), роняет `git add`
  // с fatal: pathspec ... did not match any files и срывает весь коммит — а
  // git add валится на ПЕРВОМ неизвестном пути, не доходя до остальных.
  const status = await git(repoRoot, ['status', '--porcelain', '--', ...files]);
  const dirty = files.filter((f) => status.stdout.includes(f));
  if (dirty.length === 0) {
    return { success: true, output: { commit: null, files: [], note: 'nothing_to_stage' } };
  }
  // -A: зафиксировать в т.ч. УДАЛЕНИЯ перечисленных путей.
  await git(repoRoot, ['add', '-A', '--', ...dirty]);
  const staged = await git(repoRoot, ['diff', '--cached', '--name-only']);
  const stagedFiles = staged.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (stagedFiles.length === 0) {
    return { success: true, output: { commit: null, files: [], note: 'nothing_staged' } };
  }

  // Заголовок = название от Приёмщика (task.title = short_title). Тело = его же
  // структурированное описание (task.description); если описания нет — падаем на
  // результат программиста, чтобы не оставлять тело пустым.
  const body = String(task.description || task.programmerResult || '').trim();
  const message =
    `${task.title} (task ${task.id})` +
    (body ? `\n\n${body}` : '') +
    '\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>';

  try {
    await git(repoRoot, ['commit', '-m', message]);
  } catch (error) {
    return { success: false, output: { error: `commit failed: ${error.stderr || error.message}`, files: stagedFiles } };
  }

  const head = await git(repoRoot, ['rev-parse', 'HEAD']);
  const branch = await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: '' }));

  // Пуш ТОЛЬКО в origin, best-effort: локальный коммит уже сделан, поэтому провал
  // пуша (нет origin / нет сети / non-fast-forward) не роняет роль — фиксируем
  // pushed:false + pushError, задача всё равно считается выполненной (success).
  let pushed = false;
  let pushError = null;
  const hasOrigin = await git(repoRoot, ['remote', 'get-url', 'origin']).then(() => true).catch(() => false);
  if (!hasOrigin) {
    pushError = 'no_origin';
  } else {
    try {
      await git(repoRoot, ['push', 'origin', 'HEAD']);
      pushed = true;
    } catch (error) {
      pushError = String(error.stderr || error.message || 'push failed').trim().slice(0, 500);
    }
  }

  return {
    success: true,
    output: {
      commit: head.stdout.trim(),
      branch: branch.stdout.trim(),
      files: stagedFiles,
      pushed,
      pushError,
      repoInitialized: repo.created,
    },
  };
}

export const EXECUTORS = {
  PIPELINE_SERVICE: runPipelineAction,
  GIT_INTEGRATOR: runGitAction,
};

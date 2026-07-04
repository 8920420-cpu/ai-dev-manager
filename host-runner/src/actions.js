// Реальные действия host-ролей на хосте (есть docker/git/репозиторий).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { runServicePipeline } from '../../pipeline-runner/src/index.js';

const pexec = promisify(execFile);

/**
 * PIPELINE_SERVICE: реальный прогон pipeline сервиса задачи через pipeline-runner.
 *
 * Контракт claim (`task.pipeline`) обязателен: оркестратор строит его при выдаче
 * задачи (buildPipelineClaimContract) либо отклоняет claim с 422 ещё до выдачи.
 * Выполняется pipeline ИМЕННО сервиса задачи (юнит-тесты → docker compose build →
 * docker compose up -d → smoke) сервисным слоем pipeline-runner. Провал любой
 * стадии → success=false с failedStage → штатный маршрут в Failure Analyst.
 * Отсутствующий/невалидный контракт → диагностируемый провал ДО запуска команд
 * (summary.error.code = pipeline_contract_missing и т.п.), НЕ ложный успех.
 *
 * Реконсиляция путей контракта выполняется здесь, не ломая оркестратор и
 * pipeline-runner: оркестратор кладёт в claim `projectRoot` как АБСОЛЮТНЫЙ
 * root_path проекта, а resolveServicePaths ждёт ОТНОСИТЕЛЬНЫЙ projectRoot внутри
 * абсолютного projectsRoot и отвергает абсолютный. Согласуем: projectsRoot =
 * абсолютный корень проекта (root_path), projectRoot → '.' (сам корень).
 * repositoryPath (относительный путь сервиса) остаётся как есть — по нему
 * резолвится рабочая директория сервиса внутри корня.
 */
export async function runPipelineAction(task, opts = {}) {
  const pipeline = task?.pipeline && typeof task.pipeline === 'object' ? task.pipeline : null;
  const serviceTask = pipeline ? { ...task, pipeline: { ...pipeline, projectRoot: '.' } } : task;
  const projectsRoot = opts.projectsRoot ?? String(pipeline?.projectRoot ?? '').trim();

  const servicePipelineOpts = { projectsRoot };
  if (opts.configFilename) servicePipelineOpts.configFilename = opts.configFilename;
  if (opts.createRunner) servicePipelineOpts.createRunner = opts.createRunner;
  if (opts.runnerDeps) servicePipelineOpts.runnerDeps = opts.runnerDeps;

  const result = await runServicePipeline(serviceTask, servicePipelineOpts);

  // Результат сервисного слоя уже совместим с host-task-completed
  // (output.summary/failedStage/startedAt/logPath). Дополнительно поднимаем runId
  // на верхний уровень output для обратной совместимости прежнего контракта.
  return {
    success: result.success === true,
    output: { ...result.output, runId: result.output?.summary?.runId ?? null },
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

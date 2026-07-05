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

// Заголовок коммита = название от Приёмщика (task.title = short_title). Тело =
// его же структурированное описание (task.description); если описания нет —
// падаем на результат программиста, чтобы не оставлять тело пустым.
function commitMessage(task) {
  const body = String(task.description || task.programmerResult || '').trim();
  return (
    `${task.title} (task ${task.id})` +
    (body ? `\n\n${body}` : '') +
    '\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>'
  );
}

// Пуш ТОЛЬКО в origin, best-effort: локальный коммит main уже сделан, поэтому
// провал пуша (нет origin / нет сети / non-fast-forward) не роняет роль —
// фиксируем pushed:false + pushError, задача всё равно считается выполненной.
async function pushHead(repoRoot) {
  const hasOrigin = await git(repoRoot, ['remote', 'get-url', 'origin']).then(() => true).catch(() => false);
  if (!hasOrigin) return { pushed: false, pushError: 'no_origin' };
  try {
    await git(repoRoot, ['push', 'origin', 'HEAD']);
    return { pushed: true, pushError: null };
  } catch (error) {
    return { pushed: false, pushError: String(error.stderr || error.message || 'push failed').trim().slice(0, 500) };
  }
}

// Прежний путь (обратная совместимость со старым программистом без worktree):
// стейджим ТОЛЬКО заявленные файлы задачи и делаем один локальный коммит.
// Возвращает нормализованный результат: { integrated, note?, commit?, ... } —
// политику «пустой итог» применяет вызывающая runGitAction.
async function integrateChangedFiles(repoRoot, task, files) {
  // Стейджим только те пути задачи, которые git реально видит как изменение
  // (модификация / добавление / удаление). Путь, которого git не знает вовсе
  // (уже закоммичен ранее, либо никогда не существовал), роняет `git add`
  // с fatal: pathspec ... did not match any files и срывает весь коммит — а
  // git add валится на ПЕРВОМ неизвестном пути, не доходя до остальных.
  const status = await git(repoRoot, ['status', '--porcelain', '--', ...files]);
  const dirty = files.filter((f) => status.stdout.includes(f));
  if (dirty.length === 0) return { integrated: false, note: 'nothing_to_stage' };
  // -A: зафиксировать в т.ч. УДАЛЕНИЯ перечисленных путей.
  await git(repoRoot, ['add', '-A', '--', ...dirty]);
  const staged = await git(repoRoot, ['diff', '--cached', '--name-only']);
  const stagedFiles = staged.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (stagedFiles.length === 0) return { integrated: false, note: 'nothing_staged' };

  try {
    await git(repoRoot, ['commit', '-m', commitMessage(task)]);
  } catch (error) {
    return { error: `commit failed: ${error.stderr || error.message}`, extra: { files: stagedFiles } };
  }
  const head = await git(repoRoot, ['rev-parse', 'HEAD']);
  const branch = await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: '' }));
  return { integrated: true, commit: head.stdout.trim(), branch: branch.stdout.trim(), files: stagedFiles };
}

// Новый путь: программист сдал дельту КОММИТОМ в ветке worktree
// (programmer/<project>/<service>). Вливаем ИМЕННО дельту программиста в main
// внутри repoRoot cherry-pick'ом коммита deliveredCommit (fallback — ветка).
// cherry-pick применяет только дельту задачи поверх текущего main и устойчив к
// расхождению истории (другие сервисы/док-коммиты уже влиты в main).
async function integrateWorktreeBranch(repoRoot, { worktreeBranch, deliveredCommit }) {
  const ref = deliveredCommit || worktreeBranch;
  // Ветка/коммит программиста должны существовать в этом же репозитории (worktree
  // — отдельное дерево ТОГО ЖЕ репо). Иначе интегрировать нечего — честный провал.
  const resolved = await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])
    .then((r) => r.stdout.trim())
    .catch(() => '');
  if (!resolved) return { error: `worktree ref not found: ${ref}`, note: 'worktree_ref_missing' };

  const before = await git(repoRoot, ['rev-parse', 'HEAD']).then((r) => r.stdout.trim()).catch(() => null);
  // Дельта уже в main (коммит — предок HEAD)? Тогда доносить нечего.
  if (before) {
    const already = await git(repoRoot, ['merge-base', '--is-ancestor', resolved, 'HEAD'])
      .then(() => true).catch(() => false);
    if (already) return { integrated: false, note: 'already_integrated' };
  }

  // Идентичность коммитера задаём флагами -c, чтобы не зависеть от глобального
  // git-config хоста (cherry-pick сохраняет исходного АВТОРА, но требует коммитера).
  const ident = [
    '-c', `user.email=${process.env.GIT_AUTHOR_EMAIL || 'ai-dev-manager@local'}`,
    '-c', `user.name=${process.env.GIT_AUTHOR_NAME || 'AI Dev Manager'}`,
  ];
  try {
    // -x фиксирует исходный SHA в теле коммита — дельту в main можно проследить.
    await git(repoRoot, [...ident, 'cherry-pick', '-x', resolved]);
  } catch (error) {
    // Конфликт/пустая дельта: cherry-pick атомарен, откатываем незавершённое
    // состояние, чтобы не оставить дерево в mid-state.
    await git(repoRoot, ['cherry-pick', '--abort']).catch(() => {});
    const stderr = String(error.stderr || error.message || '').trim();
    if (/empty/i.test(stderr)) return { integrated: false, note: 'empty_delta' };
    return { error: `cherry-pick failed: ${stderr.slice(0, 500)}`, note: 'cherry_pick_failed' };
  }

  const head = await git(repoRoot, ['rev-parse', 'HEAD']).then((r) => r.stdout.trim());
  if (before && head === before) return { integrated: false, note: 'empty_delta' };
  const branch = await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: '' }));
  const changed = await git(repoRoot, ['diff', '--name-only', `${head}^`, head]).then((r) => r.stdout).catch(() => '');
  return {
    integrated: true,
    commit: head,
    branch: branch.stdout.trim(),
    files: changed.split('\n').map((s) => s.trim()).filter(Boolean),
    mergedFrom: worktreeBranch,
    deliveredCommit: resolved,
  };
}

/**
 * GIT_INTEGRATOR: довести код задачи до main и запушить в origin (best-effort).
 *
 * Два режима сдачи:
 *   (1) worktreeBranch задан — программист сдал дельту КОММИТОМ в ветке worktree
 *       (programmer/<project>/<service>); вливаем эту дельту (deliveredCommit) в
 *       main внутри repoRoot cherry-pick'ом. Коммит main существует локально даже
 *       при провале пуша.
 *   (2) worktreeBranch НЕ задан — прежний путь (обратная совместимость): стейдж
 *       task.changedFiles и один локальный коммит.
 *
 * Пустой итог интеграции (нечего сливать), КОГДА изменения ЗАЯВЛЕНЫ (непустой
 * changedFiles ИЛИ worktreeBranch с непустым deliveredCommit) — это ПРОВАЛ
 * (success:false, note empty_deliverable_declared_changes): иначе конвейер
 * «зелёный», а код не доехал до main. Пустой итог при реально пустой сдаче
 * (нет ветки и пустой changedFiles) — прежний success:true note no_changed_files.
 */
export async function runGitAction(task, opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const files = (task.changedFiles ?? []).filter(
    (f) => typeof f === 'string' && f.trim() !== '' && !f.includes('..') && !path.isAbsolute(f),
  );
  const worktreeBranch =
    typeof task.worktreeBranch === 'string' && task.worktreeBranch.trim() !== '' ? task.worktreeBranch.trim() : null;
  const deliveredCommit =
    typeof task.deliveredCommit === 'string' && task.deliveredCommit.trim() !== '' ? task.deliveredCommit.trim() : null;

  // Изменения ЗАЯВЛЕНЫ, если программист сдал ветку worktree с коммитом-дельтой
  // ЛИБО перечислил changedFiles. От этого зависит трактовка пустого итога.
  const declaredChanges = files.length > 0 || (worktreeBranch !== null && deliveredCommit !== null);

  // Реально пустая сдача (нет ветки и пустой changedFiles) — прежнее поведение.
  if (!worktreeBranch && files.length === 0) {
    return { success: true, output: { commit: null, files: [], note: 'no_changed_files' } };
  }

  // Репозиторий может быть ещё не создан — инициализируем автоматически.
  const repo = await ensureRepo(repoRoot);

  const res = worktreeBranch
    ? await integrateWorktreeBranch(repoRoot, { worktreeBranch, deliveredCommit })
    : await integrateChangedFiles(repoRoot, task, files);

  // Явная ошибка интеграции (конфликт cherry-pick, сбой commit, нет ref) — провал.
  if (res.error) {
    return { success: false, output: { error: res.error, note: res.note ?? 'integration_failed', ...(res.extra ?? {}) } };
  }

  // Пустой итог: заявленные изменения не доехали — провал; иначе тихий success.
  if (!res.integrated) {
    const note = res.note ?? 'no_changed_files';
    if (declaredChanges) {
      return {
        success: false,
        output: {
          commit: null,
          files: [],
          note: 'empty_deliverable_declared_changes',
          reason: note,
          worktreeBranch,
          deliveredCommit,
          declaredFiles: files,
        },
      };
    }
    return { success: true, output: { commit: null, files: [], note } };
  }

  const push = await pushHead(repoRoot);
  return {
    success: true,
    output: {
      commit: res.commit,
      branch: res.branch,
      files: res.files,
      ...(res.mergedFrom ? { mergedFrom: res.mergedFrom, deliveredCommit: res.deliveredCommit } : {}),
      pushed: push.pushed,
      pushError: push.pushError,
      repoInitialized: repo.created,
    },
  };
}

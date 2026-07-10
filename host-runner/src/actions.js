// Реальные действия host-ролей на хосте (есть docker/git/репозиторий).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { rm } from 'node:fs/promises';
import { runServicePipeline } from '../../pipeline-runner/src/index.js';
import { runAutodeploy } from './autodeploy.js';
import { withRepoWorktreeLock } from '../../shared/repoWorktreeLock.js';

const pexec = promisify(execFile);

const sanitizeSeg = (s) => String(s ?? '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60) || '_';

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
  const baseProjectsRoot = opts.projectsRoot ?? String(pipeline?.projectRoot ?? '').trim();

  // Прогон pipeline в заданном корне проекта (projectsRoot). Вынесено в замыкание,
  // чтобы withPipelineWorktree мог подменить корень на изолированный checkout.
  const runIn = async (projectsRoot) => {
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
  };

  // WORKTREE-ISOLATE-DELIVERY-001: TESTING гоняется на изолированном checkout
  // доставленной ветки сервиса (общее дерево Программист больше не пишет). Нет
  // baseProjectsRoot / нет worktree-сдачи → фолбэк на общее дерево (см. функцию).
  if (!baseProjectsRoot) return runIn(baseProjectsRoot);
  return withPipelineWorktree(baseProjectsRoot, task, runIn);
}

// WORKTREE-ISOLATE-DELIVERY-001: поднять эфемерный worktree на доставленном коммите
// (detached), прогнать в нём `run(projectsRoot)` и снести worktree. Так тесты видят
// ровно доставленный код в ИЗОЛЯЦИИ, а общее дерево репозитория остаётся чистым (его
// пишет только Git Integrator). Ссылку резолвим в самом репозитории: deliveredCommit
// приоритетнее (точный SHA дельты), иначе tip ветки. Любой сбой (не git-репо, ссылка
// не резолвится, worktree add упал) → БЕЗОПАСНЫЙ фолбэк на общее дерево (прежнее
// поведение, совместимость с legacy-сдачей без worktree).
async function withPipelineWorktree(repoRoot, task, run) {
  const branch = typeof task?.worktreeBranch === 'string' && task.worktreeBranch.trim() ? task.worktreeBranch.trim() : '';
  const commit = typeof task?.deliveredCommit === 'string' && task.deliveredCommit.trim() ? task.deliveredCommit.trim() : '';
  const ref = commit || branch;
  if (!ref) return run(repoRoot); // legacy-сдача без worktree → общее дерево

  // Репозиторий должен резолвить ссылку локально, иначе изолировать нечего.
  const isRepo = await git(repoRoot, ['rev-parse', '--is-inside-work-tree']).then(() => true).catch(() => false);
  const resolved = isRepo
    ? await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then((r) => r.stdout.trim()).catch(() => '')
    : '';
  if (!resolved) return run(repoRoot); // не git-репо / ссылка не резолвится → фолбэк

  const dir = path.join(os.tmpdir(), 'ai-dev-pipeline-worktrees', `${sanitizeSeg(task?.id)}-${process.pid}-${Date.now()}`);
  // worktree add/remove — структурные операции .git: сериализуем межпроцессно с
  // programmer-runner (worktree add) и Git Integrator (cherry-pick) на том же репо
  // (тот же лок, что и в WorktreeManager.withRepoLock / integrateWorktreeBranch).
  try {
    await withRepoWorktreeLock(repoRoot, () =>
      git(repoRoot, ['worktree', 'add', '--detach', '--force', dir, resolved]));
  } catch {
    return run(repoRoot); // не смогли изолировать — безопасный фолбэк на общее дерево
  }
  try {
    return await run(dir);
  } finally {
    await withRepoWorktreeLock(repoRoot, async () => {
      await git(repoRoot, ['worktree', 'remove', '--force', dir]).catch(() => {});
      await git(repoRoot, ['worktree', 'prune']).catch(() => {});
    }).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function git(repoRoot, args) {
  return pexec('git', ['-C', repoRoot, ...args], { maxBuffer: 8 << 20 });
}

// Blob-SHA пути в дереве коммита/ref (пусто, если пути там нет — напр. удаление).
async function blobInCommit(repoRoot, ref, p) {
  return git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}:${p}`])
    .then((r) => r.stdout.trim())
    .catch(() => '');
}

// Blob-SHA файла в рабочем дереве (пусто, если файла нет). hash-object устойчив к
// бинарным файлам и работает для untracked-путей — в отличие от `git diff`, который
// untracked-файл игнорирует и ложно показывает расхождение.
async function blobInWorktree(repoRoot, p) {
  return git(repoRoot, ['hash-object', '--', p])
    .then((r) => r.stdout.trim())
    .catch(() => '');
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

// Новый путь: программист сдал дельту КОММИТАМИ в ветке worktree
// (programmer/<project>/<service>). Вливаем ВСЮ дельту ветки в main внутри
// repoRoot — cherry-pick'ом ДИАПАЗОНА merge-base(HEAD, tip)..tip по порядку, а не
// только последнего deliveredCommit. Иначе при многокоммитной сдаче (первый
// прогон упал по max turns, но закоммитил основную работу; второй докоммитил
// мелочь) в main уезжала лишь последняя дельта, а основная работа тихо терялась.
// cherry-pick диапазона применяет дельту задачи поверх текущего main и устойчив к
// расхождению истории (другие сервисы/док-коммиты уже влиты в main). deliveredCommit
// оставлен как подсказка/валидация (tip ветки должен его содержать), с fallback на
// него, если ветка почему-то не резолвится.
async function integrateWorktreeBranch(repoRoot, { worktreeBranch, deliveredCommit, taskId }) {
  // Ветка/коммит программиста должны существовать в этом же репозитории (worktree
  // — отдельное дерево ТОГО ЖЕ репо). Иначе интегрировать нечего — честный провал.
  const resolveRef = (ref) =>
    git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]).then((r) => r.stdout.trim()).catch(() => '');

  // tip интеграции = tip ветки программиста (вливаем ВСЮ её дельту). Fallback на
  // deliveredCommit, если ветка не резолвится.
  const delivered = deliveredCommit ? await resolveRef(deliveredCommit) : '';
  let tip = worktreeBranch ? await resolveRef(worktreeBranch) : '';
  if (!tip) tip = delivered;
  if (!tip) {
    const ref = deliveredCommit || worktreeBranch;
    return { error: `worktree ref not found: ${ref}`, note: 'worktree_ref_missing' };
  }

  // Валидация подсказки: tip ветки ДОЛЖЕН содержать deliveredCommit. Если ветка
  // рассинхронизирована и его не содержит — вливаем ДО deliveredCommit, чтобы
  // заявленная дельта точно доехала до main.
  if (delivered && tip !== delivered) {
    const contained = await git(repoRoot, ['merge-base', '--is-ancestor', delivered, tip])
      .then(() => true).catch(() => false);
    if (!contained) tip = delivered;
  }

  const before = await git(repoRoot, ['rev-parse', 'HEAD']).then((r) => r.stdout.trim()).catch(() => null);

  // Диапазон дельты: merge-base(HEAD, tip)..tip — коммиты ветки после расхождения
  // с main. Если tip уже предок HEAD (merge-base === tip) — вся ветка в main.
  let range = tip;
  if (before) {
    const mergeBase = await git(repoRoot, ['merge-base', 'HEAD', tip]).then((r) => r.stdout.trim()).catch(() => '');
    if (mergeBase === tip) return { integrated: false, note: 'already_integrated', tip };
    range = mergeBase ? `${mergeBase}..${tip}` : tip;
  }

  // Коммиты диапазона по порядку (старые → новые), чтобы cherry-pick ложился
  // поверх main последовательно.
  const revList = await git(repoRoot, ['rev-list', '--reverse', '--topo-order', range])
    .then((r) => r.stdout).catch(() => '');
  const commits = revList.split('\n').map((s) => s.trim()).filter(Boolean);
  if (commits.length === 0) return { integrated: false, note: 'already_integrated', tip };

  // ── Санитайзер грязного дубля дельты ─────────────────────────────────────────
  // Pipeline Service гоняет тесты/сборку в ОСНОВНОМ дереве repoRoot и оставляет
  // там незакоммиченный дубль дельты сдачи. cherry-pick тех же путей затем
  // детерминированно падает: «Your local changes ... would be overwritten by
  // merge» (для новых файлов — «untracked working tree files would be
  // overwritten»). Если грязные пути интегрируемого диапазона — именно дубль (их
  // содержимое в рабочем дереве совпадает с tip), уносим их в stash и продолжаем;
  // после успешной интеграции stash дропаем (дельта уже в main). Если содержимое
  // НЕ совпадает с tip — это чужая незакоммиченная работа: честный провал, файлы
  // не трогаем (не затираем чужой труд).
  const affected = new Set();
  for (const commit of commits) {
    const names = await git(repoRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', commit])
      .then((r) => r.stdout).catch(() => '');
    names.split('\n').map((s) => s.trim()).filter(Boolean).forEach((n) => affected.add(n));
  }
  let autostashRef = null;
  if (affected.size > 0) {
    const status = await git(repoRoot, ['status', '--porcelain', '--', ...affected])
      .then((r) => r.stdout).catch(() => '');
    // Пути дельты, которые git видит грязными (модификация / удаление / untracked).
    const dirty = status.split('\n').filter(Boolean).map((line) => {
      const p = line.slice(3);
      const arrow = p.indexOf(' -> ');
      return arrow >= 0 ? p.slice(arrow + 4) : p; // при rename берём целевое имя
    }).filter(Boolean);
    if (dirty.length > 0) {
      // Дубль дельты ⇔ содержимое рабочего дерева совпадает с tip для КАЖДОГО
      // грязного пути (удаление: путь отсутствует и в дереве, и в tip → оба blob
      // пусты). Иначе это не дубль, а чужое незакоммиченное содержимое.
      const mismatched = [];
      for (const p of dirty) {
        const [tipBlob, workBlob] = await Promise.all([
          blobInCommit(repoRoot, tip, p),
          blobInWorktree(repoRoot, p),
        ]);
        if (tipBlob !== workBlob) mismatched.push(p);
      }
      if (mismatched.length > 0) {
        return {
          error:
            `dirty worktree conflicts with integration and is NOT a delta duplicate ` +
            `(содержимое расходится с веткой ${worktreeBranch}, чужая незакоммиченная ` +
            `работа не затирается): ${mismatched.join(', ')}`,
          note: 'dirty_worktree_conflict',
          extra: { dirtyPaths: dirty, mismatchedPaths: mismatched },
        };
      }
      // Все грязные пути — дубль дельты раннера: уносим в stash с говорящим
      // сообщением (для ручного разбора) и продолжаем интеграцию.
      const stashMsg = `gi-autostash ${taskId || 'unknown'} ${worktreeBranch}`;
      try {
        await git(repoRoot, ['stash', 'push', '-u', '-m', stashMsg, '--', ...dirty]);
        autostashRef = 'stash@{0}';
      } catch (error) {
        const stderr = String(error.stderr || error.message || '').trim();
        return { error: `autostash failed: ${stderr.slice(0, 500)}`, note: 'autostash_failed' };
      }
    }
  }

  // Идентичность коммитера задаём флагами -c, чтобы не зависеть от глобального
  // git-config хоста (cherry-pick сохраняет исходного АВТОРА, но требует коммитера).
  const ident = [
    '-c', `user.email=${process.env.GIT_AUTHOR_EMAIL || 'ai-dev-manager@local'}`,
    '-c', `user.name=${process.env.GIT_AUTHOR_NAME || 'AI Dev Manager'}`,
  ];

  let applied = 0;
  for (const commit of commits) {
    // Коммит уже в main (предок HEAD)? пропускаем как уже влитый.
    const already = await git(repoRoot, ['merge-base', '--is-ancestor', commit, 'HEAD'])
      .then(() => true).catch(() => false);
    if (already) continue;
    try {
      // -x фиксирует исходный SHA в теле коммита — дельту в main можно проследить.
      await git(repoRoot, [...ident, 'cherry-pick', '-x', commit]);
      applied += 1;
    } catch (error) {
      const stderr = String(error.stderr || error.message || '').trim();
      // Пустая дельта (коммит уже эквивалентно в main) — не провал: пропускаем
      // этот коммит и продолжаем с остальными.
      if (/empty|nothing to commit/i.test(stderr)) {
        await git(repoRoot, ['cherry-pick', '--skip'])
          .catch(() => git(repoRoot, ['cherry-pick', '--abort']).catch(() => {}));
        continue;
      }
      // Конфликт/иная ошибка: cherry-pick атомарен, откатываем незавершённое
      // состояние, чтобы не оставить дерево в mid-state.
      await git(repoRoot, ['cherry-pick', '--abort']).catch(() => {});
      // Провал: autostash с дублем дельты НЕ дропаем — оставляем для ручного
      // разбора и отдаём его ref в диагностике.
      return {
        error: `cherry-pick failed: ${stderr.slice(0, 500)}`,
        note: 'cherry_pick_failed',
        ...(autostashRef ? { extra: { autostash: autostashRef } } : {}),
      };
    }
  }

  const head = await git(repoRoot, ['rev-parse', 'HEAD']).then((r) => r.stdout.trim());
  // Пустой итог — интеграция не состоялась: autostash (если был) НЕ дропаем,
  // оставляем для ручного разбора и отдаём ref в диагностике. tip и affectedFiles
  // отдаём вызывающему — runGitAction сверит содержимое tip с HEAD и отличит
  // «дельта уже в main» (штатный повторный прогон) от «дельта потерялась» (провал).
  if (applied === 0 || (before && head === before)) {
    return {
      integrated: false, note: 'empty_delta', tip, affectedFiles: [...affected],
      ...(autostashRef ? { extra: { autostash: autostashRef } } : {}),
    };
  }
  // Интеграция удалась: дубль дельты уже в main — снимаем autostash.
  if (autostashRef) await git(repoRoot, ['stash', 'drop']).catch(() => {});
  const branch = await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: '' }));
  // Файлы = изменения по ВСЕМУ интегрированному диапазону (before..HEAD), а не
  // только по последнему коммиту.
  const diffBase = before || `${head}^`;
  const changed = await git(repoRoot, ['diff', '--name-only', diffBase, head]).then((r) => r.stdout).catch(() => '');
  return {
    integrated: true,
    commit: head,
    branch: branch.stdout.trim(),
    files: changed.split('\n').map((s) => s.trim()).filter(Boolean),
    mergedFrom: worktreeBranch,
    deliveredCommit: delivered || tip,
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
 * «зелёный», а код не доехал до main. ИСКЛЮЧЕНИЕ: если содержимое tip ветки уже
 * дословно в HEAD (повторный прогон после успешной интеграции / ручного вливания) —
 * это success note already_integrated_content, и доставка выполняется как обычно.
 * Пустой итог при реально пустой сдаче (нет ветки и пустой changedFiles) —
 * прежний success:true note no_changed_files.
 *
 * TASK-AUTODEPLOY-K3S-001: после успешной интеграции файлы дельты сопоставляются
 * с картой доставки репозитория (deploy/autodeploy.json) — совпавшие цели
 * пересобираются, пушатся в registry и раскатываются в k3s (см. autodeploy.js).
 * Провал доставки = провал роли (note autodeploy_failed): «код в main, а прод
 * старый» перестал быть тихим состоянием.
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

  // WORKTREE-CROSSPROC-LOCK-001: структурные git-операции интеграции (stash/cherry-pick/
  // reset/commit) на repoRoot гоняются с `git worktree add/prune` программиста на том же
  // репозитории (разные процессы) → worktree_ensure_failed / index.lock ENOENT. Берём
  // общий межпроцессный лок (тот же ключ, что WorktreeManager.withRepoLock программиста).
  const res = await withRepoWorktreeLock(repoRoot, () => (worktreeBranch
    ? integrateWorktreeBranch(repoRoot, { worktreeBranch, deliveredCommit, taskId: task.id })
    : integrateChangedFiles(repoRoot, task, files)), { log: opts.log });

  // Явная ошибка интеграции (конфликт cherry-pick, сбой commit, нет ref) — провал.
  if (res.error) {
    return { success: false, output: { error: res.error, note: res.note ?? 'integration_failed', ...(res.extra ?? {}) } };
  }

  // TASK-AUTODEPLOY-K3S-001: доставка дельты до прода по карте репозитория
  // (deploy/autodeploy.json; нет карты/совпадений → no-op). Общая для свежей
  // интеграции и подтверждённого повтора (already_integrated_content), чтобы
  // ретрай упавшей доставки был обычным повторным прогоном роли.
  const autodeploy = opts.autodeploy ?? runAutodeploy;
  const deployAndFinish = async (payload, deployFiles) => {
    const deploy = await autodeploy(repoRoot, deployFiles, { log: opts.deployLog ?? (() => {}) })
      .catch((error) => ({ attempted: true, ok: false, targets: [], error: String(error?.message ?? error).slice(0, 700) }));
    if (deploy.attempted && !deploy.ok) {
      // Интеграция состоялась, но прод не обновился — честный провал с диагностикой
      // (BLOCKED). Повторный прогон роли доинтегрирует ничего (контент уже в main)
      // и повторит только доставку.
      return { success: false, output: { ...payload, note: 'autodeploy_failed', deploy } };
    }
    return { success: true, output: { ...payload, ...(deploy.attempted ? { deploy } : {}) } };
  };

  // Пустой итог: если содержимое tip уже в HEAD (повторный прогон после успешной
  // интеграции — например, ретрай упавшей доставки или ручное вливание) — это
  // успех already_integrated_content, и доставка всё равно выполняется. Иначе
  // заявленные изменения не доехали — провал; при пустой сдаче — тихий success.
  if (!res.integrated) {
    const note = res.note ?? 'no_changed_files';
    if (declaredChanges) {
      const verifyPaths = (res.affectedFiles?.length ? res.affectedFiles : files).filter(Boolean);
      const contentPresent = res.tip
        ? await git(repoRoot, ['diff', '--quiet', res.tip, 'HEAD', '--', ...(verifyPaths.length ? verifyPaths : ['.'])])
          .then(() => true).catch(() => false)
        : false;
      if (contentPresent) {
        // Дубль дельты в autostash больше не нужен: содержимое подтверждено в main.
        if (res.extra?.autostash) await git(repoRoot, ['stash', 'drop']).catch(() => {});
        const push = await pushHead(repoRoot);
        return deployAndFinish({
          commit: null,
          files: verifyPaths,
          note: 'already_integrated_content',
          reason: note,
          worktreeBranch,
          deliveredCommit,
          pushed: push.pushed,
          pushError: push.pushError,
        }, verifyPaths);
      }
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
  return deployAndFinish({
    commit: res.commit,
    branch: res.branch,
    files: res.files,
    ...(res.mergedFrom ? { mergedFrom: res.mergedFrom, deliveredCommit: res.deliveredCommit } : {}),
    pushed: push.pushed,
    pushError: push.pushError,
    repoInitialized: repo.created,
  }, res.files);
}

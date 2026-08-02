// TASK-AUTODEPLOY-K3S-001 — авто-доставка интегрированной дельты до прода (k3s).
//
// Проблема: Git Integrator вливает дельту сервиса в main и пушит в origin, но прод
// (k3s, ns ps-prod) тянет ОБРАЗЫ из registry — код в main сам по себе на прод не
// попадает. Раньше publish+rollout делали руками (scripts/publish-all.ps1 в репо ПС)
// и об этом регулярно забывали: конвейер «зелёный», а на фронте старый код.
//
// Решение: декларативная карта доставки в САМОМ целевом репозитории —
// <repoRoot>/deploy/autodeploy.json. Git Integrator после успешной интеграции
// сопоставляет файлы дельты с path-префиксами целей и для каждой совпавшей цели:
//   docker compose build <svc> → docker tag/push в registries → kubectl rollout
//   restart deployment/<name> -n <ns> + rollout status.
// Нет файла карты / нет совпавших целей → тихий no-op (поведение прежних проектов
// не меняется). Провал любой стадии доставки → провал роли (задача BLOCKED с
// диагностикой стадии) — «зелёный конвейер без прода» больше невозможен.
//
// ВАЖНО (системный баг доставки): rollout restart сам по себе НЕ применяет
// изменённые манифесты кластера — он лишь пере-pull'ит образ на СТАРОМ spec.
// Поэтому правки Deployment-spec (readinessProbe/env), ConfigMap (nginx.conf),
// Service и особенно Ingress под deploy/k8s-prod/ доезжают в main, но в кластер
// не попадают. Отдельная НЕЗАВИСИМАЯ от image-целей секция manifestApply
// применяет изменённые манифесты декларативно ПЕРЕД раскаткой образов:
//   • kustomizeRoot задан → `kubectl apply -k <root>` (учитывает kustomize
//     replacements, напр. CANONICAL_HOST из ConfigMap);
//   • иначе → пофайловый `kubectl apply -f <manifest>` по изменённым YAML.
// apply идёт ПЕРВЫМ: обновляет spec (в т.ч. probe/ConfigMap/Ingress), а финальный
// `rollout status` в цикле образов дождётся подов уже с НОВЫМ spec и образом.
// Ingress/ConfigMap-only правки, не совпавшие ни с одной image-целью, всё равно
// доезжают этим путём (attempted:true даже при пустом targets). Провал apply =
// провал роли (как и провал rollout). Идемпотентно (apply повторно безопасен).
//
// Формат deploy/autodeploy.json:
// {
//   "kubeconfig": "F:/git/server/albia/registry/kubeconfig",  // абсолютный или относительно repoRoot
//   "namespace": "ps-prod",
//   "buildEnvFile": "compose.build.env",                       // --env-file для docker compose
//   "buildRegistry": "localhost:5000",                         // IMAGE_REGISTRY при сборке
//   "pushRegistries": ["localhost:5000", "192.168.1.211:5000"],
//   "rolloutTimeoutSec": 180,
//   "totalBudgetMs": 1200000,
//   "manifestApply": {                                          // опционально: apply изменённых манифестов
//     "kustomizeRoot": "deploy/k8s-prod",                       // корень с kustomization.yaml → apply -k; нет → apply -f
//     "paths": ["deploy/k8s-prod/"],                            // префиксы deploy-путей, триггерящие apply (дефолт: [kustomizeRoot + '/'])
//     "namespace": "ps-prod"                                    // опционально; иначе берётся namespace карты
//   },
//   "targets": [
//     { "deployment": "psweb", "image": "psweb",
//       "compose": "WebStore/docker-compose.yml", "service": "psweb",
//       "paths": ["WebStore/PSweb/", "packages/"],
//       "builtImage": "localhost:5000/psweb:latest" },          // опционально, если тег сборки ≠ <buildRegistry>/<image>:latest
//     { "job": "etl-reaper", "manifest": "deploy/k8s-prod/42-etl-reaper-job.yaml",
//       "image": "etl-reaper", "compose": "ETL/docker-compose.yml", "service": "etl-reaper",
//       "builtImage": "localhost:5000/etl-reaper:local",
//       "waitSec": 0,                                           // >0 → ждать condition=complete столько секунд
//       "paths": ["ETL/ETL-Reaper/"] }
//   ]
// }
//
// Цели-Job (`job` вместо `deployment`) — для сервисов, которые разворачиваются как
// batch/v1 Job, а не Deployment: `rollout restart` к ним неприменим в принципе, и
// без отдельного сценария правки такого сервиса доезжали в main, но в рантайм не
// попадали НИКОГДА (случай etl-reaper: образ в registry отставал от main на неделю).
// Job'у нельзя обновить spec поверх (поля template иммутабельны), поэтому доставка
// такой цели = build → push → `kubectl delete job` → `kubectl apply -f <manifest>`.
// Старые раннеры такие цели просто пропускают (у них нет `deployment`), поэтому
// карту можно обновлять раньше раннера — доставка деградирует до прежнего no-op,
// а не до ошибочного rollout несуществующего Deployment.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const pexec = promisify(execFile);

// AUTODEPLOY-DEDUP-001 — не катать прод повторно тем же коммитом.
//
// Fork/join даёт ДВА прогона Git Integrator подряд на одной задаче: дочерняя ветка
// вливает дельту и доставляет её, затем родительская после join приходит с пустой
// дельтой (note already_integrated_content) и катает те же цели второй раз. Деплой
// при повторе задуман намеренно — так ретрай УПАВШЕЙ доставки остаётся обычным
// повторным прогоном роли, — но в fork/join это лишний перекат прода: новая
// ревизия Deployment, ещё один rollout status, ~50 секунд впустую.
//
// Различаем по факту, а не по намерению: после успешной раскатки цели пишем
// отметку {sha, at} в .git/ai-dev-autodeploy-state.json. Следующий прогон
// пропускает цель, если ТОТ ЖЕ коммит уже раскатан недавно. Провал доставки
// отметку не пишет — ретрай штатно катает заново. Файл лежит в .git/ (в коммиты
// не попадает, живёт с репозиторием), сбой чтения/записи — тихий no-op.
const DEFAULT_DEDUP_TTL_MS = 15 * 60_000;
const DELIVERY_STATE_FILE = 'ai-dev-autodeploy-state.json';

function deliveryStatePath(repoRoot) {
  return path.join(repoRoot, '.git', DELIVERY_STATE_FILE);
}

export async function readDeliveryState(repoRoot, { readFileImpl = readFile } = {}) {
  try {
    const parsed = JSON.parse(await readFileImpl(deliveryStatePath(repoRoot), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeDeliveryState(repoRoot, state, { writeFileImpl = writeFile } = {}) {
  try {
    await writeFileImpl(deliveryStatePath(repoRoot), JSON.stringify(state), 'utf8');
  } catch {
    /* отметка — оптимизация, а не контракт: не смогли записать → просто не дедуплицируем */
  }
}

// Ключ цели в отметке доставки: Deployment и Job с одинаковым именем — разные цели.
export function deliveryKey(t) {
  return t.deployment ? `deployment:${t.deployment}` : `job:${t.job}`;
}

// Прочитать карту доставки репозитория. Нет файла → null (доставка не настроена).
// Битый JSON — громкая ошибка (карта есть, но не работает — молчать нельзя).
export async function loadAutodeployConfig(repoRoot, { readFileImpl = readFile } = {}) {
  const file = path.join(repoRoot, 'deploy', 'autodeploy.json');
  let raw;
  try {
    raw = await readFileImpl(file, 'utf8');
  } catch {
    return null;
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (error) {
    throw new Error(`autodeploy.json: невалидный JSON (${error.message})`);
  }
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.targets)) return null;
  return cfg;
}

// Ключ цели: Deployment (rollout restart) либо Job (пересоздание по манифесту).
// Job-цель обязана нести `manifest` — пересоздавать её больше нечем. Возвращает
// null для цели, которую этот раннер раскатать не умеет (её просто пропускают).
function targetKey(t) {
  if (t?.deployment) return `deployment/${t.deployment}`;
  if (t?.job && t?.manifest) return `job/${t.job}`;
  return null;
}

// Чистая функция: цели доставки, чьи path-префиксы совпали с файлами дельты.
// Пути нормализуются к forward-slash (git отдаёт их так, но changedFiles из событий
// исторически бывали с backslash). Дедуп по цели (Deployment/Job), порядок — как в карте.
export function pickAutodeployTargets(files, config) {
  const norm = (Array.isArray(files) ? files : [])
    .map((f) => String(f ?? '').replaceAll('\\', '/').trim())
    .filter(Boolean);
  if (!norm.length) return [];
  const out = [];
  const seen = new Set();
  for (const t of config?.targets ?? []) {
    const key = targetKey(t);
    if (!key || !t.compose || !t.service || seen.has(key)) continue;
    const prefixes = (Array.isArray(t.paths) ? t.paths : [])
      .map((p) => String(p ?? '').replaceAll('\\', '/'))
      .filter(Boolean);
    if (!prefixes.length) continue;
    if (norm.some((f) => prefixes.some((p) => f.startsWith(p)))) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

// Чистая функция: план apply изменённых манифестов кластера по секции
// manifestApply. Независима от image-целей — Ingress/ConfigMap-only правки,
// не совпавшие ни с одной image-целью, всё равно попадают в план. Возвращает
// { kustomizeRoot, namespace, files } либо null (секции нет / нет совпавших
// deploy-файлов / в files-режиме нет YAML-манифестов). Пути нормализуются к
// forward-slash (как в pickAutodeployTargets).
export function pickManifestApply(files, config) {
  const ma = config?.manifestApply;
  if (!ma || typeof ma !== 'object') return null;
  const norm = (Array.isArray(files) ? files : [])
    .map((f) => String(f ?? '').replaceAll('\\', '/').trim())
    .filter(Boolean);
  if (!norm.length) return null;
  const kustomizeRoot = ma.kustomizeRoot
    ? String(ma.kustomizeRoot).replaceAll('\\', '/').replace(/\/+$/, '')
    : null;
  // Дефолт префиксов: корень kustomize (иначе матчить нечем).
  const prefixes = (Array.isArray(ma.paths) && ma.paths.length
    ? ma.paths
    : (kustomizeRoot ? [`${kustomizeRoot}/`] : []))
    .map((p) => String(p ?? '').replaceAll('\\', '/'))
    .filter(Boolean);
  if (!prefixes.length) return null;
  let matched = norm.filter((f) => prefixes.some((p) => f.startsWith(p)));
  // Пофайловый apply (нет kustomize-корня) применим только к YAML-манифестам:
  // README/скрипты/kustomization под deploy/ не подаются в `kubectl apply -f`.
  // Для kustomize-корня фильтр не нужен — apply -k раскатывает весь корень.
  if (!kustomizeRoot) matched = matched.filter((f) => /\.ya?ml$/i.test(f));
  if (!matched.length) return null;
  return {
    kustomizeRoot,
    namespace: ma.namespace ? String(ma.namespace) : null,
    files: matched,
  };
}

// Выполнить доставку совпавших целей + apply изменённых манифестов кластера.
// Возвращает отчёт, пригодный для payload события задачи: { attempted, reason?,
// namespace?, targets: [{deployment, image, ok, stage, error?}], manifest?, ok }.
// Цели независимы: провал одной не останавливает остальные (итоговый ok = все
// ok И manifest.ok), НО общий бюджет времени ограничен totalBudgetMs (дефолт
// 20 мин < орфан-таймаута оркестратора 25 мин) — цели за бюджетом помечаются
// budget_exceeded и доедут при повторном прогоне (сборка закэширована, rollout и
// apply идемпотентны). manifestApply независим от image-целей: apply
// выполняется ПЕРВЫМ (обновляет spec/ConfigMap/Ingress), даже если ни одна
// image-цель не совпала (Ingress-only правка → attempted:true, targets:[]).
export async function runAutodeploy(repoRoot, files, { config, exec = pexec, log = () => {}, now = Date.now } = {}) {
  const cfg = config !== undefined ? config : await loadAutodeployConfig(repoRoot);
  if (!cfg) return { attempted: false, reason: 'no_config' };
  const targets = pickAutodeployTargets(files, cfg);
  const plan = pickManifestApply(files, cfg);
  // Нет ни совпавших image-целей, ни изменённых манифестов → нечего доставлять.
  if (!targets.length && !plan) return { attempted: false, reason: 'no_matching_targets' };

  // rawNamespace — как задан в карте (может отсутствовать); namespace с дефолтом
  // 'default' используется для rollout, applyNamespace — для apply (см. ниже).
  const rawNamespace = cfg.namespace ? String(cfg.namespace) : null;
  const namespace = rawNamespace || 'default';
  const buildRegistry = String(cfg.buildRegistry || 'localhost:5000').replace(/\/+$/, '');
  const pushRegistries = (Array.isArray(cfg.pushRegistries) && cfg.pushRegistries.length
    ? cfg.pushRegistries : [buildRegistry]).map((r) => String(r).replace(/\/+$/, ''));
  const kubeconfig = cfg.kubeconfig ? path.resolve(repoRoot, String(cfg.kubeconfig)) : null;
  // IMAGE_REGISTRY — интерполяция image: в compose (OS-env побеждает --env-file).
  const env = { ...process.env, IMAGE_REGISTRY: buildRegistry, ...(kubeconfig ? { KUBECONFIG: kubeconfig } : {}) };
  const buildTimeoutMs = Number(cfg.buildTimeoutMs) > 0 ? Number(cfg.buildTimeoutMs) : 15 * 60_000;
  const rolloutTimeoutSec = Number(cfg.rolloutTimeoutSec) > 0 ? Number(cfg.rolloutTimeoutSec) : 180;
  const totalBudgetMs = Number(cfg.totalBudgetMs) > 0 ? Number(cfg.totalBudgetMs) : 20 * 60_000;
  const startedAt = now();

  // ── Apply изменённых манифестов кластера (ПЕРЕД раскаткой образов) ────────────
  // Ключевое отличие от rollout restart: apply обновляет объявленный spec —
  // readinessProbe/env в Deployment, ConfigMap (nginx.conf), Service, Ingress.
  // -n передаётся только если namespace известен: kustomization обычно задаёт
  // namespace сам, а `-n default` затёр бы его для ресурсов без явного ns.
  let manifest = null;
  if (plan) {
    const applyNamespace = plan.namespace || rawNamespace;
    const nsArgs = applyNamespace ? ['-n', applyNamespace] : [];
    manifest = { ok: false, stage: 'apply', mode: plan.kustomizeRoot ? 'kustomize' : 'files', applied: [] };
    if (now() - startedAt > totalBudgetMs) {
      manifest.stage = 'skipped';
      manifest.error = 'budget_exceeded: манифесты применятся при повторном прогоне роли';
    } else {
      try {
        if (plan.kustomizeRoot) {
          log(`autodeploy: kubectl apply -k ${plan.kustomizeRoot}`);
          await exec('kubectl', ['apply', '-k', plan.kustomizeRoot, ...nsArgs],
            { cwd: repoRoot, env, maxBuffer: 8 << 20, timeout: 120_000 });
          manifest.applied = [plan.kustomizeRoot];
        } else {
          for (const f of plan.files) {
            log(`autodeploy: kubectl apply -f ${f}`);
            await exec('kubectl', ['apply', '-f', f, ...nsArgs],
              { cwd: repoRoot, env, maxBuffer: 8 << 20, timeout: 120_000 });
          }
          manifest.applied = [...plan.files];
        }
        manifest.stage = 'done';
        manifest.ok = true;
      } catch (error) {
        manifest.error = String(error?.stderr || error?.message || error).trim().slice(0, 700);
        log(`autodeploy: apply манифестов провал на стадии ${manifest.stage}: ${manifest.error}`);
      }
    }
  }

  // AUTODEPLOY-DEDUP-001: отметки уже раскатанных целей и текущий коммит main.
  // Не смогли определить HEAD (не git-репо, сбой) → дедупликация выключена и
  // поведение прежнее: катаем всё, как раньше.
  // HEAD спрашиваем только когда есть что раскатывать: при apply-only прогоне
  // (правка одних манифестов) дедуплицировать нечего.
  const dedupTtlMs = Number(cfg.deliveryDedupTtlMs) >= 0 ? Number(cfg.deliveryDedupTtlMs) : DEFAULT_DEDUP_TTL_MS;
  const headSha = targets.length && dedupTtlMs > 0
    ? await exec('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { cwd: repoRoot, timeout: 30_000 })
      .then((r) => String(r?.stdout ?? '').trim() || null)
      .catch(() => null)
    : null;
  const deliveryState = headSha && dedupTtlMs > 0 ? await readDeliveryState(repoRoot) : {};
  let deliveryStateDirty = false;

  const results = [];
  for (const t of targets) {
    const isJob = !t.deployment && Boolean(t.job);
    const r = isJob
      ? { job: t.job, image: t.image, ok: false, stage: null }
      : { deployment: t.deployment, image: t.image, ok: false, stage: null };
    results.push(r);
    if (now() - startedAt > totalBudgetMs) {
      r.stage = 'skipped';
      r.error = 'budget_exceeded: цель доедет при повторном прогоне роли';
      continue;
    }
    // Тот же коммит уже раскатан недавно (типовой случай — второй Git Integrator
    // после join): цель считается доставленной, ok:true. Прод не трогаем.
    const mark = headSha && dedupTtlMs > 0 ? deliveryState[deliveryKey(t)] : null;
    if (mark && mark.sha === headSha && Number.isFinite(Number(mark.at)) && now() - Number(mark.at) < dedupTtlMs) {
      r.stage = 'done';
      r.ok = true;
      r.skipped = 'already_delivered_same_commit';
      log(`autodeploy: ${deliveryKey(t)} уже раскатан коммитом ${headSha.slice(0, 8)} — пропуск`);
      continue;
    }
    try {
      r.stage = 'build';
      log(`autodeploy: build ${t.service} (${t.compose})`);
      const composeArgs = ['compose'];
      if (cfg.buildEnvFile) composeArgs.push('--env-file', String(cfg.buildEnvFile));
      composeArgs.push('-f', String(t.compose), 'build', String(t.service));
      await exec('docker', composeArgs, { cwd: repoRoot, env, maxBuffer: 64 << 20, timeout: buildTimeoutMs });

      r.stage = 'push';
      const builtImage = String(t.builtImage || `${buildRegistry}/${t.image}:latest`);
      for (const reg of pushRegistries) {
        const ref = `${reg}/${t.image}:latest`;
        if (ref !== builtImage) {
          await exec('docker', ['tag', builtImage, ref], { cwd: repoRoot, env, timeout: 60_000 });
        }
        log(`autodeploy: push ${ref}`);
        await exec('docker', ['push', ref], { cwd: repoRoot, env, maxBuffer: 16 << 20, timeout: 5 * 60_000 });
      }

      if (isJob) {
        // Job нельзя обновить apply'ем поверх: поля spec.template иммутабельны, и
        // apply на живой Job с новым spec падает. Пересоздаём: delete (--wait, чтобы
        // apply не наткнулся на удаляемый объект) → apply манифеста. Именно delete+
        // apply, а не только push образа: без пересоздания новый образ никто не
        // запустит — Job однократный, рестартовать нечего.
        r.stage = 'recreate';
        log(`autodeploy: delete job/${t.job} -n ${namespace} → apply -f ${t.manifest}`);
        await exec('kubectl', ['delete', 'job', String(t.job), '-n', namespace, '--ignore-not-found', '--wait=true'],
          { cwd: repoRoot, env, timeout: 120_000 });
        await exec('kubectl', ['apply', '-f', String(t.manifest), '-n', namespace],
          { cwd: repoRoot, env, maxBuffer: 4 << 20, timeout: 60_000 });
        // Ожидание завершения — опция: разовый Job может идти дольше бюджета роли,
        // и «доставка» для него = запущенный прогон на новом образе. waitSec>0
        // включает ожидание там, где итог прогона важен для успеха доставки.
        const waitSec = Number(t.waitSec) > 0 ? Number(t.waitSec) : 0;
        if (waitSec > 0) {
          r.stage = 'wait';
          await exec('kubectl', ['wait', '--for=condition=complete', `job/${t.job}`, '-n', namespace,
            `--timeout=${waitSec}s`],
            { cwd: repoRoot, env, maxBuffer: 4 << 20, timeout: (waitSec + 30) * 1000 });
        }
      } else {
        r.stage = 'rollout';
        log(`autodeploy: rollout restart deployment/${t.deployment} -n ${namespace}`);
        await exec('kubectl', ['rollout', 'restart', `deployment/${t.deployment}`, '-n', namespace],
          { cwd: repoRoot, env, timeout: 60_000 });
        await exec('kubectl', ['rollout', 'status', `deployment/${t.deployment}`, '-n', namespace,
          `--timeout=${rolloutTimeoutSec}s`],
          { cwd: repoRoot, env, maxBuffer: 4 << 20, timeout: (rolloutTimeoutSec + 30) * 1000 });
      }

      r.stage = 'done';
      r.ok = true;
      // AUTODEPLOY-DEDUP-001: отметку ставим ТОЛЬКО после успешной раскатки —
      // упавшая доставка её не пишет, и ретрай катает цель заново.
      if (headSha && dedupTtlMs > 0) {
        deliveryState[deliveryKey(t)] = { sha: headSha, at: now() };
        deliveryStateDirty = true;
      }
    } catch (error) {
      r.error = String(error?.stderr || error?.message || error).trim().slice(0, 700);
      log(`autodeploy: ${t.deployment || `job/${t.job}`} провал на стадии ${r.stage}: ${r.error}`);
    }
  }
  if (deliveryStateDirty) await writeDeliveryState(repoRoot, deliveryState);
  // Итоговый ok = все image-цели ok И apply манифестов ok (если применялся).
  // manifest.ok=false (или budget_exceeded → stage skipped, ok=false) роняет
  // роль так же, как провал rollout: «код в main, но spec/Ingress старый» — тоже
  // не тихое состояние.
  const targetsOk = results.every((x) => x.ok);
  const manifestOk = manifest ? manifest.ok : true;
  return {
    attempted: true,
    namespace,
    targets: results,
    ...(manifest ? { manifest } : {}),
    ok: targetsOk && manifestOk,
  };
}

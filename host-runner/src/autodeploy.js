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
// Формат deploy/autodeploy.json:
// {
//   "kubeconfig": "F:/git/server/albia/registry/kubeconfig",  // абсолютный или относительно repoRoot
//   "namespace": "ps-prod",
//   "buildEnvFile": "compose.build.env",                       // --env-file для docker compose
//   "buildRegistry": "localhost:5000",                         // IMAGE_REGISTRY при сборке
//   "pushRegistries": ["localhost:5000", "192.168.1.211:5000"],
//   "rolloutTimeoutSec": 180,
//   "totalBudgetMs": 1200000,
//   "targets": [
//     { "deployment": "psweb", "image": "psweb",
//       "compose": "WebStore/docker-compose.yml", "service": "psweb",
//       "paths": ["WebStore/PSweb/", "packages/"],
//       "builtImage": "localhost:5000/psweb:latest" }           // опционально, если тег сборки ≠ <buildRegistry>/<image>:latest
//   ]
// }
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const pexec = promisify(execFile);

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

// Чистая функция: цели доставки, чьи path-префиксы совпали с файлами дельты.
// Пути нормализуются к forward-slash (git отдаёт их так, но changedFiles из событий
// исторически бывали с backslash). Дедуп по deployment, порядок — как в карте.
export function pickAutodeployTargets(files, config) {
  const norm = (Array.isArray(files) ? files : [])
    .map((f) => String(f ?? '').replaceAll('\\', '/').trim())
    .filter(Boolean);
  if (!norm.length) return [];
  const out = [];
  const seen = new Set();
  for (const t of config?.targets ?? []) {
    if (!t || !t.deployment || !t.compose || !t.service || seen.has(t.deployment)) continue;
    const prefixes = (Array.isArray(t.paths) ? t.paths : [])
      .map((p) => String(p ?? '').replaceAll('\\', '/'))
      .filter(Boolean);
    if (!prefixes.length) continue;
    if (norm.some((f) => prefixes.some((p) => f.startsWith(p)))) {
      seen.add(t.deployment);
      out.push(t);
    }
  }
  return out;
}

// Выполнить доставку совпавших целей. Возвращает отчёт, пригодный для payload
// события задачи: { attempted, reason?, namespace?, targets: [{deployment, image,
// ok, stage, error?}], ok }. Цели независимы: провал одной не останавливает
// остальные (итоговый ok = все ok), НО общий бюджет времени ограничен
// totalBudgetMs (дефолт 20 мин < орфан-таймаута оркестратора 25 мин) — цели за
// бюджетом помечаются budget_exceeded и доедут при повторном прогоне (сборка
// закэширована, rollout идемпотентен).
export async function runAutodeploy(repoRoot, files, { config, exec = pexec, log = () => {}, now = Date.now } = {}) {
  const cfg = config !== undefined ? config : await loadAutodeployConfig(repoRoot);
  if (!cfg) return { attempted: false, reason: 'no_config' };
  const targets = pickAutodeployTargets(files, cfg);
  if (!targets.length) return { attempted: false, reason: 'no_matching_targets' };

  const namespace = String(cfg.namespace || 'default');
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

  const results = [];
  for (const t of targets) {
    const r = { deployment: t.deployment, image: t.image, ok: false, stage: null };
    results.push(r);
    if (now() - startedAt > totalBudgetMs) {
      r.stage = 'skipped';
      r.error = 'budget_exceeded: цель доедет при повторном прогоне роли';
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

      r.stage = 'rollout';
      log(`autodeploy: rollout restart deployment/${t.deployment} -n ${namespace}`);
      await exec('kubectl', ['rollout', 'restart', `deployment/${t.deployment}`, '-n', namespace],
        { cwd: repoRoot, env, timeout: 60_000 });
      await exec('kubectl', ['rollout', 'status', `deployment/${t.deployment}`, '-n', namespace,
        `--timeout=${rolloutTimeoutSec}s`],
        { cwd: repoRoot, env, maxBuffer: 4 << 20, timeout: (rolloutTimeoutSec + 30) * 1000 });

      r.stage = 'done';
      r.ok = true;
    } catch (error) {
      r.error = String(error?.stderr || error?.message || error).trim().slice(0, 700);
      log(`autodeploy: ${t.deployment} провал на стадии ${r.stage}: ${r.error}`);
    }
  }
  return { attempted: true, namespace, targets: results, ok: results.every((x) => x.ok) };
}

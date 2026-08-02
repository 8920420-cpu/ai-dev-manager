// TASK-AUTODEPLOY-K3S-001 — авто-доставка интегрированной дельты в k3s:
// сопоставление image-целей по path-префиксам, последовательность команд
// доставки, ВЫБОР изменённых манифестов для apply (kustomize/пофайлово) и их
// раскатка в кластер (не только образ), провал apply/доставки = провал роли.
//
// Примечание: интеграционные тесты runGitAction↔autodeploy живут рядом с
// проводкой в actions.js (deployAndFinish). Здесь покрыт сам модуль autodeploy.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAutodeployConfig, pickAutodeployTargets, pickManifestApply, runAutodeploy } from '../src/autodeploy.js';
import { runGitAction } from '../src/actions.js';

const CFG = {
  kubeconfig: 'deploy/kubeconfig',
  namespace: 'ps-prod',
  buildEnvFile: 'compose.build.env',
  buildRegistry: 'localhost:5000',
  pushRegistries: ['localhost:5000', '192.168.1.211:5000'],
  targets: [
    { deployment: 'psweb', image: 'psweb', compose: 'WebStore/docker-compose.yml', service: 'psweb', paths: ['WebStore/PSweb/', 'packages/'] },
    { deployment: 'chat-service', image: 'chat-service', compose: 'CRM/docker-compose.yml', service: 'chat_service', paths: ['CRM/Chat_Service/backend/', 'proto-contracts/chat/'] },
  ],
};

// Подделка exec: пишет вызовы, по желанию валит заданную команду.
function fakeExec(calls, { failOn = null } = {}) {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const line = `${cmd} ${args.join(' ')}`;
    if (failOn && line.includes(failOn)) {
      const e = new Error(`fail: ${line}`);
      e.stderr = `stderr of ${line}`;
      throw e;
    }
    return { stdout: '', stderr: '' };
  };
}

// ── pickAutodeployTargets ─────────────────────────────────────────────────────
test('pickAutodeployTargets: совпадение по префиксу, дедуп, нормализация слешей', () => {
  const hit = pickAutodeployTargets(
    ['WebStore\\PSweb\\frontend\\src\\index.css', 'WebStore/PSweb/frontend/src/lib/readModel.ts', 'API_MAP.md'],
    CFG,
  );
  assert.deepEqual(hit.map((t) => t.deployment), ['psweb']);
});

test('pickAutodeployTargets: один файл может зацепить несколько целей', () => {
  const cfg = {
    targets: [
      ...CFG.targets,
      { deployment: 'getway-datahub', image: 'getway-datahub', compose: 'PS-Torg/docker-compose.yml', service: 'getway_datahub', paths: ['proto-contracts/'] },
    ],
  };
  const hit = pickAutodeployTargets(['proto-contracts/chat/chat.proto'], cfg);
  assert.deepEqual(hit.map((t) => t.deployment), ['chat-service', 'getway-datahub']);
});

test('pickAutodeployTargets: пустые файлы/нет совпадений → []', () => {
  assert.deepEqual(pickAutodeployTargets([], CFG), []);
  assert.deepEqual(pickAutodeployTargets(['docs/README.md'], CFG), []);
  assert.deepEqual(pickAutodeployTargets(['WebStore/PSweb/x.ts'], { targets: [] }), []);
});

// ── loadAutodeployConfig ──────────────────────────────────────────────────────
test('loadAutodeployConfig: нет файла → null; битый JSON → ошибка; валидный → объект', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(await loadAutodeployConfig(dir), null);

  mkdirSync(path.join(dir, 'deploy'), { recursive: true });
  writeFileSync(path.join(dir, 'deploy', 'autodeploy.json'), '{broken');
  await assert.rejects(() => loadAutodeployConfig(dir), /невалидный JSON/);

  writeFileSync(path.join(dir, 'deploy', 'autodeploy.json'), JSON.stringify(CFG));
  const cfg = await loadAutodeployConfig(dir);
  assert.equal(cfg.namespace, 'ps-prod');
  assert.equal(cfg.targets.length, 2);
});

// ── runAutodeploy ─────────────────────────────────────────────────────────────
test('runAutodeploy: последовательность build → tag/push × registries → rollout', async () => {
  const calls = [];
  const res = await runAutodeploy('/repo', ['WebStore/PSweb/frontend/src/index.css'], {
    config: CFG, exec: fakeExec(calls),
  });
  assert.equal(res.attempted, true);
  assert.equal(res.ok, true);
  assert.deepEqual(res.targets, [{ deployment: 'psweb', image: 'psweb', ok: true, stage: 'done' }]);
  const lines = calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
  assert.deepEqual(lines, [
    // AUTODEPLOY-DEDUP-001: HEAD спрашивается один раз перед раскаткой image-целей
    // (fake-exec отдаёт пустой stdout → отметки выключены, поведение прежнее).
    'git -C /repo rev-parse HEAD',
    'docker compose --env-file compose.build.env -f WebStore/docker-compose.yml build psweb',
    // первый registry совпадает с образом сборки — tag не нужен
    'docker push localhost:5000/psweb:latest',
    'docker tag localhost:5000/psweb:latest 192.168.1.211:5000/psweb:latest',
    'docker push 192.168.1.211:5000/psweb:latest',
    'kubectl rollout restart deployment/psweb -n ps-prod',
    'kubectl rollout status deployment/psweb -n ps-prod --timeout=180s',
  ]);
  // Сборка получает IMAGE_REGISTRY, kubectl — KUBECONFIG (резолв от repoRoot).
  // Ищем по команде, а не по индексу: перед раскаткой идёт ещё git rev-parse HEAD.
  const build = calls.find((c) => c.cmd === 'docker' && c.args.includes('build'));
  const rollout = calls.find((c) => c.cmd === 'kubectl' && c.args.includes('restart'));
  assert.equal(build.opts.env.IMAGE_REGISTRY, 'localhost:5000');
  assert.equal(rollout.opts.env.KUBECONFIG, path.resolve('/repo', 'deploy/kubeconfig'));
});

test('runAutodeploy: провал стадии → ok:false со стадией и stderr, остальные цели не бросаются', async () => {
  const calls = [];
  const res = await runAutodeploy('/repo', ['WebStore/PSweb/a.ts', 'CRM/Chat_Service/backend/b.go'], {
    config: CFG, exec: fakeExec(calls, { failOn: 'build psweb' }),
  });
  assert.equal(res.attempted, true);
  assert.equal(res.ok, false);
  const psweb = res.targets.find((t) => t.deployment === 'psweb');
  assert.equal(psweb.ok, false);
  assert.equal(psweb.stage, 'build');
  assert.match(psweb.error, /stderr of/);
  // Вторая цель доехала независимо от провала первой.
  const chat = res.targets.find((t) => t.deployment === 'chat-service');
  assert.equal(chat.ok, true);
});

test('runAutodeploy: нет карты/совпадений → attempted:false', async () => {
  assert.deepEqual(await runAutodeploy('/repo', ['x.ts'], { config: null }), { attempted: false, reason: 'no_config' });
  assert.deepEqual(await runAutodeploy('/repo', ['docs/x.md'], { config: CFG }), { attempted: false, reason: 'no_matching_targets' });
});

test('runAutodeploy: исчерпание totalBudgetMs помечает хвост budget_exceeded', async () => {
  let tick = 0;
  const res = await runAutodeploy('/repo', ['WebStore/PSweb/a.ts', 'CRM/Chat_Service/backend/b.go'], {
    config: { ...CFG, totalBudgetMs: 5 },
    exec: fakeExec([]),
    now: () => (tick += 10), // каждый замер времени продвигает часы за бюджет
  });
  assert.equal(res.ok, false);
  assert.equal(res.targets[0].stage, 'skipped');
  assert.match(res.targets[0].error, /budget_exceeded/);
});

// ── Цели-Job (batch/v1 Job вместо Deployment) ─────────────────────────────────
// Сервис-Job (etl-reaper) нельзя раскатать rollout restart'ом: Deployment'а нет, а
// spec живого Job иммутабелен. Доставка = build → push → delete job → apply -f.
const CFG_JOB = {
  ...CFG,
  targets: [
    ...CFG.targets,
    {
      job: 'etl-reaper', manifest: 'deploy/k8s-prod/42-etl-reaper-job.yaml',
      image: 'etl-reaper', compose: 'ETL/docker-compose.yml', service: 'etl-reaper',
      builtImage: 'localhost:5000/etl-reaper:local',
      paths: ['ETL/ETL-Reaper/', 'ETL/Dockerfile.etl_reaper'],
    },
  ],
};

test('pickAutodeployTargets: job-цель совпадает по префиксу и дедупится по имени Job', () => {
  const hit = pickAutodeployTargets(['ETL/ETL-Reaper/backend/main.go'], CFG_JOB);
  assert.deepEqual(hit.map((t) => t.job), ['etl-reaper']);
  // Дедуп: две одноимённые job-цели в карте дают одну.
  const dup = pickAutodeployTargets(['ETL/ETL-Reaper/x.go'], {
    targets: [CFG_JOB.targets[2], { ...CFG_JOB.targets[2], paths: ['ETL/'] }],
  });
  assert.equal(dup.length, 1);
});

test('pickAutodeployTargets: цель без deployment и без manifest не раскатывается', () => {
  // Job без манифеста пересоздавать нечем — такая цель игнорируется целиком.
  const cfg = { targets: [{ job: 'etl-reaper', image: 'etl-reaper', compose: 'ETL/docker-compose.yml', service: 'etl-reaper', paths: ['ETL/'] }] };
  assert.deepEqual(pickAutodeployTargets(['ETL/ETL-Reaper/main.go'], cfg), []);
});

test('runAutodeploy: job-цель → build → push → delete job → apply -f манифеста', async () => {
  const calls = [];
  const res = await runAutodeploy('/repo', ['ETL/ETL-Reaper/backend/main.go'], {
    config: CFG_JOB, exec: fakeExec(calls),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.targets, [{ job: 'etl-reaper', image: 'etl-reaper', ok: true, stage: 'done' }]);
  const lines = calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
  assert.deepEqual(lines, [
    // AUTODEPLOY-DEDUP-001: HEAD спрашивается один раз перед раскаткой image-целей
    // (fake-exec отдаёт пустой stdout → отметки выключены, поведение прежнее).
    'git -C /repo rev-parse HEAD',
    'docker compose --env-file compose.build.env -f ETL/docker-compose.yml build etl-reaper',
    // builtImage (:local) отличается от тега registry — tag нужен в оба registry.
    'docker tag localhost:5000/etl-reaper:local localhost:5000/etl-reaper:latest',
    'docker push localhost:5000/etl-reaper:latest',
    'docker tag localhost:5000/etl-reaper:local 192.168.1.211:5000/etl-reaper:latest',
    'docker push 192.168.1.211:5000/etl-reaper:latest',
    'kubectl delete job etl-reaper -n ps-prod --ignore-not-found --wait=true',
    'kubectl apply -f deploy/k8s-prod/42-etl-reaper-job.yaml -n ps-prod',
  ]);
  // Никакого rollout restart: Deployment'а с таким именем в кластере нет.
  assert.ok(!lines.some((l) => l.includes('rollout')));
});

test('runAutodeploy: waitSec>0 → ожидание condition=complete, провал ожидания роняет цель', async () => {
  const cfg = { ...CFG_JOB, targets: [{ ...CFG_JOB.targets[2], waitSec: 600 }] };
  const calls = [];
  const ok = await runAutodeploy('/repo', ['ETL/ETL-Reaper/main.go'], { config: cfg, exec: fakeExec(calls) });
  assert.equal(ok.ok, true);
  assert.equal(
    calls.map((c) => `${c.cmd} ${c.args.join(' ')}`).at(-1),
    'kubectl wait --for=condition=complete job/etl-reaper -n ps-prod --timeout=600s',
  );
  const failed = await runAutodeploy('/repo', ['ETL/ETL-Reaper/main.go'], {
    config: cfg, exec: fakeExec([], { failOn: 'wait --for=condition=complete' }),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.targets[0].stage, 'wait');
});

test('runAutodeploy: провал delete job → стадия recreate, deployment-цели не задеты', async () => {
  const res = await runAutodeploy('/repo', ['ETL/ETL-Reaper/main.go', 'WebStore/PSweb/a.ts'], {
    config: CFG_JOB, exec: fakeExec([], { failOn: 'delete job' }),
  });
  assert.equal(res.ok, false);
  const job = res.targets.find((t) => t.job === 'etl-reaper');
  assert.equal(job.stage, 'recreate');
  assert.equal(res.targets.find((t) => t.deployment === 'psweb').ok, true);
});

// Карта с секцией manifestApply (kustomize-корень deploy/k8s-prod). image-цели те
// же (psweb/chat-service), namespace ps-prod.
const CFG_KUSTOMIZE = {
  ...CFG,
  manifestApply: { kustomizeRoot: 'deploy/k8s-prod', paths: ['deploy/k8s-prod/'], namespace: 'ps-prod' },
};

// ── pickManifestApply: ВЫБОР «что применять» по изменённым файлам deploy/ ──────
test('pickManifestApply: изменённый манифест под kustomize-корнем → план apply -k', () => {
  const plan = pickManifestApply(
    ['deploy/k8s-prod/60-ingress.yaml', 'WebStore/PSweb/frontend/src/index.css'],
    CFG_KUSTOMIZE,
  );
  assert.equal(plan.kustomizeRoot, 'deploy/k8s-prod');
  assert.deepEqual(plan.files, ['deploy/k8s-prod/60-ingress.yaml']);
  assert.equal(plan.namespace, 'ps-prod');
});

test('pickManifestApply: нормализация backslash, дефолт paths от kustomizeRoot', () => {
  const plan = pickManifestApply(
    ['deploy\\k8s-prod\\51-chat-frontend.yaml'],
    { manifestApply: { kustomizeRoot: 'deploy/k8s-prod' } },
  );
  assert.equal(plan.kustomizeRoot, 'deploy/k8s-prod');
  assert.deepEqual(plan.files, ['deploy/k8s-prod/51-chat-frontend.yaml']);
});

test('pickManifestApply: нет секции / нет совпадений → null', () => {
  // В CFG нет manifestApply — даже совпавший deploy-файл не даёт план.
  assert.equal(pickManifestApply(['deploy/k8s-prod/60-ingress.yaml'], CFG), null);
  // Файлы вне deploy-префиксов.
  assert.equal(pickManifestApply(['src/app.ts'], CFG_KUSTOMIZE), null);
  // Пустой список файлов.
  assert.equal(pickManifestApply([], CFG_KUSTOMIZE), null);
});

test('pickManifestApply: files-режим (без kustomizeRoot) → только YAML-манифесты', () => {
  const cfg = { manifestApply: { paths: ['deploy/k8s-prod/'] } };
  const plan = pickManifestApply(
    ['deploy/k8s-prod/50-service.yaml', 'deploy/k8s-prod/60-ingress.yml', 'deploy/k8s-prod/README.md'],
    cfg,
  );
  assert.equal(plan.kustomizeRoot, null);
  // README.md отфильтрован — в apply -f подаются только манифесты.
  assert.deepEqual(plan.files, ['deploy/k8s-prod/50-service.yaml', 'deploy/k8s-prod/60-ingress.yml']);
});

test('pickManifestApply: только не-YAML под deploy/ в files-режиме → null', () => {
  const cfg = { manifestApply: { paths: ['deploy/k8s-prod/'] } };
  assert.equal(pickManifestApply(['deploy/k8s-prod/README.md'], cfg), null);
});

// ── runAutodeploy: apply изменённых манифестов ────────────────────────────────
test('runAutodeploy: apply -k выполняется ПЕРЕД раскаткой образа целей', async () => {
  const calls = [];
  const res = await runAutodeploy('/repo', ['WebStore/PSweb/x.ts', 'deploy/k8s-prod/51-chat-frontend.yaml'], {
    config: CFG_KUSTOMIZE, exec: fakeExec(calls),
  });
  assert.equal(res.attempted, true);
  assert.equal(res.ok, true);
  assert.equal(res.manifest.ok, true);
  assert.equal(res.manifest.mode, 'kustomize');
  assert.deepEqual(res.manifest.applied, ['deploy/k8s-prod']);
  const lines = calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
  // apply -k — самая первая команда, ДО docker build и rollout restart образа.
  assert.equal(lines[0], 'kubectl apply -k deploy/k8s-prod -n ps-prod');
  assert.ok(
    lines.indexOf('kubectl apply -k deploy/k8s-prod -n ps-prod') <
      lines.findIndex((l) => l.startsWith('kubectl rollout restart')),
    'apply манифестов должен предшествовать rollout образа',
  );
  // apply получает KUBECONFIG (резолв от repoRoot), как и остальные kubectl.
  assert.equal(calls[0].opts.env.KUBECONFIG, path.resolve('/repo', 'deploy/kubeconfig'));
});

test('runAutodeploy: правка ТОЛЬКО Ingress (без совпадения с image-целью) всё равно применяется', async () => {
  const calls = [];
  const res = await runAutodeploy('/repo', ['deploy/k8s-prod/60-ingress.yaml'], {
    config: CFG_KUSTOMIZE, exec: fakeExec(calls),
  });
  assert.equal(res.attempted, true);
  assert.deepEqual(res.targets, [], 'ни одна image-цель не совпала');
  assert.equal(res.manifest.ok, true);
  assert.equal(res.ok, true);
  const lines = calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
  assert.deepEqual(lines, ['kubectl apply -k deploy/k8s-prod -n ps-prod']);
});

test('runAutodeploy: провал apply → ok:false, manifest.stage=apply (провал роли)', async () => {
  const calls = [];
  const res = await runAutodeploy('/repo', ['deploy/k8s-prod/60-ingress.yaml'], {
    config: CFG_KUSTOMIZE, exec: fakeExec(calls, { failOn: 'apply -k' }),
  });
  assert.equal(res.attempted, true);
  assert.equal(res.ok, false);
  assert.equal(res.manifest.ok, false);
  assert.equal(res.manifest.stage, 'apply');
  assert.match(res.manifest.error, /stderr of/);
});

test('runAutodeploy: files-режим → apply -f по каждому изменённому YAML', async () => {
  const calls = [];
  const cfg = { targets: [], namespace: 'ps-prod', kubeconfig: 'deploy/kubeconfig', manifestApply: { paths: ['deploy/k8s-prod/'] } };
  const res = await runAutodeploy('/repo', ['deploy/k8s-prod/40-configmap.yaml', 'deploy/k8s-prod/60-ingress.yaml'], {
    config: cfg, exec: fakeExec(calls),
  });
  assert.equal(res.manifest.mode, 'files');
  assert.equal(res.ok, true);
  const lines = calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
  assert.deepEqual(lines, [
    'kubectl apply -f deploy/k8s-prod/40-configmap.yaml -n ps-prod',
    'kubectl apply -f deploy/k8s-prod/60-ingress.yaml -n ps-prod',
  ]);
});

test('runAutodeploy: apply И раскатка образа вместе → ok = manifest.ok И targets.ok', async () => {
  const calls = [];
  const res = await runAutodeploy('/repo', ['WebStore/PSweb/frontend/src/index.css', 'deploy/k8s-prod/40-orchestrator.yaml'], {
    config: CFG_KUSTOMIZE, exec: fakeExec(calls),
  });
  assert.equal(res.ok, true);
  assert.equal(res.manifest.ok, true);
  assert.deepEqual(res.targets.map((t) => t.deployment), ['psweb']);
  // Полная последовательность: apply -k, затем весь цикл образа psweb.
  const lines = calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
  assert.deepEqual(lines, [
    'kubectl apply -k deploy/k8s-prod -n ps-prod',
    // AUTODEPLOY-DEDUP-001: HEAD спрашивается один раз перед раскаткой image-целей
    // (fake-exec отдаёт пустой stdout → отметки выключены, поведение прежнее).
    'git -C /repo rev-parse HEAD',
    'docker compose --env-file compose.build.env -f WebStore/docker-compose.yml build psweb',
    'docker push localhost:5000/psweb:latest',
    'docker tag localhost:5000/psweb:latest 192.168.1.211:5000/psweb:latest',
    'docker push 192.168.1.211:5000/psweb:latest',
    'kubectl rollout restart deployment/psweb -n ps-prod',
    'kubectl rollout status deployment/psweb -n ps-prod --timeout=180s',
  ]);
});

// ── Интеграция с runGitAction ─────────────────────────────────────────────────
function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function initRepo(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'giad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '--quiet']);
  git(dir, ['config', 'user.email', 'test@local']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'init']);
  git(dir, ['branch', '-M', 'main']);
  return dir;
}

function commitDeltaBranch(dir, branch, file, content) {
  git(dir, ['checkout', '--quiet', '-b', branch]);
  writeFileSync(path.join(dir, file), content);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'programmer: task delta']);
  const sha = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['checkout', '--quiet', 'main']);
  return sha;
}

test('runGitAction: после интеграции вызывается autodeploy с файлами дельты', async (t) => {
  const dir = initRepo(t);
  const sha = commitDeltaBranch(dir, 'programmer/P/psweb', 'feature.js', 'export const x = 1;\n');
  const seen = [];
  const res = await runGitAction(
    { id: 't1', title: 'x', worktreeBranch: 'programmer/P/psweb', deliveredCommit: sha, changedFiles: ['feature.js'] },
    { repoRoot: dir, autodeploy: async (root, files) => { seen.push({ root, files }); return { attempted: true, ok: true, targets: [] }; } },
  );
  assert.equal(res.success, true);
  assert.deepEqual(seen[0].files, ['feature.js']);
  assert.equal(res.output.deploy.ok, true);
});

test('runGitAction: провал autodeploy → провал роли с note autodeploy_failed', async (t) => {
  const dir = initRepo(t);
  const sha = commitDeltaBranch(dir, 'programmer/P/psweb', 'feature.js', 'export const x = 1;\n');
  const res = await runGitAction(
    { id: 't2', title: 'x', worktreeBranch: 'programmer/P/psweb', deliveredCommit: sha, changedFiles: ['feature.js'] },
    { repoRoot: dir, autodeploy: async () => ({ attempted: true, ok: false, targets: [{ deployment: 'psweb', ok: false, stage: 'push', error: 'registry down' }] }) },
  );
  assert.equal(res.success, false);
  assert.equal(res.output.note, 'autodeploy_failed');
  // Интеграция при этом состоялась — повторный прогон пойдёт по пути already_integrated_content.
  assert.doesNotThrow(() => git(dir, ['cat-file', '-e', 'main:feature.js']));
});

test('runGitAction: повторный прогон уже влитой дельты → already_integrated_content + повтор доставки', async (t) => {
  const dir = initRepo(t);
  const sha = commitDeltaBranch(dir, 'programmer/P/psweb', 'feature.js', 'export const x = 1;\n');
  // Первый прогон вливает дельту (доставка «упала» — эмуляция ретрая).
  const first = await runGitAction(
    { id: 't3', title: 'x', worktreeBranch: 'programmer/P/psweb', deliveredCommit: sha, changedFiles: ['feature.js'] },
    { repoRoot: dir, autodeploy: async () => ({ attempted: true, ok: false, targets: [] }) },
  );
  assert.equal(first.success, false);
  // Повторный прогон: cherry-pick пуст, но содержимое tip уже в HEAD → успех + доставка.
  const seen = [];
  const second = await runGitAction(
    { id: 't3', title: 'x', worktreeBranch: 'programmer/P/psweb', deliveredCommit: sha, changedFiles: ['feature.js'] },
    { repoRoot: dir, autodeploy: async (root, files) => { seen.push(files); return { attempted: true, ok: true, targets: [] }; } },
  );
  assert.equal(second.success, true);
  assert.equal(second.output.note, 'already_integrated_content');
  assert.equal(seen.length, 1, 'доставка выполняется и при повторном прогоне');
});

test('runGitAction: дельта заявлена, но контента в main нет → прежний провал empty_deliverable', async (t) => {
  const dir = initRepo(t);
  // Ветка есть, deliveredCommit заявлен, но резолвится только README — эмулируем
  // потерю дельты: ветка указывает на корневой коммит (никакой новой дельты),
  // а changedFiles заявляет файл, которого в main нет.
  const root = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['branch', 'programmer/P/lost', root]);
  const res = await runGitAction(
    { id: 't4', title: 'x', worktreeBranch: 'programmer/P/lost', deliveredCommit: root, changedFiles: ['ghost.js'] },
    { repoRoot: dir, autodeploy: async () => ({ attempted: true, ok: true, targets: [] }) },
  );
  // tip — предок HEAD: содержимое tip в HEAD тривиально присутствует → это
  // считается already_integrated_content (истинная пустая дельта ветки).
  assert.equal(res.success, true);
  assert.equal(res.output.note, 'already_integrated_content');
});

// ── AUTODEPLOY-DEDUP-001: не катать прод повторно тем же коммитом ──────────────
// Fork/join даёт два прогона Git Integrator подряд: дочерний вливает дельту и
// раскатывает, родительский приходит с пустой дельтой и раскатывал те же цели
// второй раз (лишняя ревизия Deployment + ~50 c на rollout status).

// repoRoot с каталогом .git (там живёт отметка) + exec, отдающий заданный HEAD.
function dedupRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autodeploy-dedup-'));
  mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}
function fakeExecWithHead(calls, sha, { failOn = null } = {}) {
  return async (cmd, args, opts) => {
    const line = `${cmd} ${args.join(' ')}`;
    if (cmd === 'git' && args.includes('rev-parse')) return { stdout: `${sha}\n`, stderr: '' };
    calls.push({ cmd, args, opts });
    if (failOn && line.includes(failOn)) {
      const e = new Error(`fail: ${line}`);
      e.stderr = `stderr of ${line}`;
      throw e;
    }
    return { stdout: '', stderr: '' };
  };
}

test('AUTODEPLOY-DEDUP-001: повторный прогон тем же коммитом не трогает прод', async () => {
  const dir = dedupRepo();
  try {
    const first = [];
    const r1 = await runAutodeploy(dir, ['WebStore/PSweb/a.ts'], { config: CFG, exec: fakeExecWithHead(first, 'sha-aaa') });
    assert.equal(r1.ok, true);
    assert.equal(r1.targets[0].skipped, undefined, 'первый прогон катает по-настоящему');
    assert.ok(first.some((c) => c.cmd === 'kubectl' && c.args.includes('restart')));

    // Второй прогон (родительский GI после join): дельта та же, HEAD тот же.
    const second = [];
    const r2 = await runAutodeploy(dir, ['WebStore/PSweb/a.ts'], { config: CFG, exec: fakeExecWithHead(second, 'sha-aaa') });
    assert.equal(r2.ok, true, 'цель считается доставленной');
    assert.deepEqual(r2.targets, [{ deployment: 'psweb', image: 'psweb', ok: true, stage: 'done', skipped: 'already_delivered_same_commit' }]);
    assert.deepEqual(second, [], 'ни docker, ни kubectl не вызывались');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AUTODEPLOY-DEDUP-001: новый коммит раскатывается штатно', async () => {
  const dir = dedupRepo();
  try {
    await runAutodeploy(dir, ['WebStore/PSweb/a.ts'], { config: CFG, exec: fakeExecWithHead([], 'sha-aaa') });
    const calls = [];
    const res = await runAutodeploy(dir, ['WebStore/PSweb/a.ts'], { config: CFG, exec: fakeExecWithHead(calls, 'sha-bbb') });
    assert.equal(res.targets[0].skipped, undefined);
    assert.ok(calls.some((c) => c.cmd === 'kubectl' && c.args.includes('restart')), 'другой HEAD → раскатка');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AUTODEPLOY-DEDUP-001: упавшая доставка не ставит отметку — ретрай катает заново', async () => {
  const dir = dedupRepo();
  try {
    const r1 = await runAutodeploy(dir, ['WebStore/PSweb/a.ts'], {
      config: CFG, exec: fakeExecWithHead([], 'sha-aaa', { failOn: 'rollout restart' }),
    });
    assert.equal(r1.ok, false, 'доставка провалилась');

    const calls = [];
    const r2 = await runAutodeploy(dir, ['WebStore/PSweb/a.ts'], { config: CFG, exec: fakeExecWithHead(calls, 'sha-aaa') });
    assert.equal(r2.targets[0].skipped, undefined, 'ретрай не должен пропускать цель');
    assert.ok(calls.some((c) => c.cmd === 'kubectl' && c.args.includes('restart')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AUTODEPLOY-DEDUP-001: протухшая отметка (TTL) не блокирует раскатку', async () => {
  const dir = dedupRepo();
  try {
    await runAutodeploy(dir, ['WebStore/PSweb/a.ts'], { config: CFG, exec: fakeExecWithHead([], 'sha-aaa') });
    const calls = [];
    // deliveryDedupTtlMs=1 мс: отметка первого прогона уже вне окна.
    const res = await runAutodeploy(dir, ['WebStore/PSweb/a.ts'], {
      config: { ...CFG, deliveryDedupTtlMs: 1 }, exec: fakeExecWithHead(calls, 'sha-aaa'), now: () => Date.now() + 60_000,
    });
    assert.equal(res.targets[0].skipped, undefined);
    assert.ok(calls.some((c) => c.cmd === 'kubectl' && c.args.includes('restart')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AUTODEPLOY-DEDUP-001: deliveryDedupTtlMs=0 полностью выключает дедупликацию', async () => {
  const dir = dedupRepo();
  try {
    const cfg = { ...CFG, deliveryDedupTtlMs: 0 };
    await runAutodeploy(dir, ['WebStore/PSweb/a.ts'], { config: cfg, exec: fakeExecWithHead([], 'sha-aaa') });
    const calls = [];
    const res = await runAutodeploy(dir, ['WebStore/PSweb/a.ts'], { config: cfg, exec: fakeExecWithHead(calls, 'sha-aaa') });
    assert.equal(res.targets[0].skipped, undefined);
    assert.ok(calls.some((c) => c.cmd === 'kubectl' && c.args.includes('restart')));
    assert.ok(!calls.some((c) => c.cmd === 'git'), 'при выключенной дедупликации HEAD не спрашиваем');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

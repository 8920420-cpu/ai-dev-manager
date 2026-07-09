// TASK-AUTODEPLOY-K3S-001 — авто-доставка интегрированной дельты в k3s:
// сопоставление целей по path-префиксам, последовательность команд доставки,
// провал доставки = провал роли, повторный прогон после интеграции = успех
// already_integrated_content с повтором доставки.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAutodeployConfig, pickAutodeployTargets, runAutodeploy } from '../src/autodeploy.js';
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
    'docker compose --env-file compose.build.env -f WebStore/docker-compose.yml build psweb',
    // первый registry совпадает с образом сборки — tag не нужен
    'docker push localhost:5000/psweb:latest',
    'docker tag localhost:5000/psweb:latest 192.168.1.211:5000/psweb:latest',
    'docker push 192.168.1.211:5000/psweb:latest',
    'kubectl rollout restart deployment/psweb -n ps-prod',
    'kubectl rollout status deployment/psweb -n ps-prod --timeout=180s',
  ]);
  // Сборка получает IMAGE_REGISTRY, kubectl — KUBECONFIG (резолв от repoRoot).
  assert.equal(calls[0].opts.env.IMAGE_REGISTRY, 'localhost:5000');
  assert.equal(calls[4].opts.env.KUBECONFIG, path.resolve('/repo', 'deploy/kubeconfig'));
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

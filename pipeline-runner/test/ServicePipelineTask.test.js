import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

import {
  ServicePipelineTask,
  runServicePipeline,
  resolveServicePaths,
  PipelineTaskError,
  isServiceRelPathSafe,
  isInsideRoot,
} from '../src/ServicePipelineTask.js';
import { PipelineRunner } from '../src/PipelineRunner.js';
import { FakeExecutor, NullLogger, tmpDir, stageMap } from './helpers.js';

/**
 * Тесты сервисного слоя PIPELINE_SERVICE (PIPELINE-NON-AI-EXECUTOR-001, P1.2).
 * Проверяют: отсутствие любых LLM-вызовов, выбор правильного сервиса по
 * устойчивому serviceId (а не по тексту/CWD), выполнение всех действий,
 * path isolation (unknown service / выход за корень / соседний сервис) и
 * структурированный результат для host-task-completed.
 */

// ── Вспомогательное ──────────────────────────────────────────────────────────

/** Создать на диске сервис projects/<project>/<rel>/.pipeline.json. */
function writeService(projectsRoot, projectRel, serviceRel, cfg) {
  const dir = path.join(projectsRoot, projectRel, serviceRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, '.pipeline.json'),
    JSON.stringify({ ...cfg, stages: stageMap(cfg.stages) }, null, 2),
  );
  return dir;
}

/** Claim-DTO как его отдаёт оркестратор (POSIX-относительные пути). */
function claim({ id = 'task-1', projectRel = 'PS', serviceRel, serviceId, serviceName, serviceCode }) {
  const repositoryPath = serviceRel;
  return {
    id,
    role: 'PIPELINE_SERVICE',
    pipeline: {
      projectId: 'proj-uuid',
      projectCode: 'PS',
      serviceId,
      serviceCode: serviceCode ?? serviceId,
      serviceName: serviceName ?? serviceId,
      projectRoot: projectRel,
      repositoryPath,
      workingDirectory: `${projectRel}/${repositoryPath}`,
      pipelineConfigRef: `${projectRel}/${repositoryPath}/.pipeline.json`,
    },
  };
}

/**
 * «Растяжка»-коннектор AI: бросает исключение при ЛЮБОМ обращении. Передаётся
 * как побочная зависимость, чтобы доказать: сервисный путь к нему не обращается.
 */
function aiTripwire() {
  const handler = {
    get() {
      throw new Error('AI-коннектор НЕ должен вызываться в PIPELINE_SERVICE');
    },
    apply() {
      throw new Error('AI-коннектор НЕ должен вызываться в PIPELINE_SERVICE');
    },
  };
  return new Proxy(function aiConnector() {}, handler);
}

/** Фабрика runner с FakeExecutor: НИКАКИХ реальных процессов и сети. */
function fakeRunnerFactory(executor) {
  return ({ config }) =>
    new PipelineRunner({ config, executor, createLogger: () => new NullLogger() });
}

// ── isServiceRelPathSafe / isInsideRoot ──────────────────────────────────────

test('isServiceRelPathSafe: безопасные и небезопасные пути', () => {
  assert.equal(isServiceRelPathSafe(''), true);
  assert.equal(isServiceRelPathSafe('services/catalog'), true);
  assert.equal(isServiceRelPathSafe('./services/catalog'), true);
  assert.equal(isServiceRelPathSafe('../evil'), false);
  assert.equal(isServiceRelPathSafe('services/../../evil'), false);
  assert.equal(isServiceRelPathSafe('/abs/path'), false);
  assert.equal(isServiceRelPathSafe('C:/win'), false);
});

test('isInsideRoot: вложенность по сегментам, не по префиксу строки', () => {
  const base = path.resolve('/projects/PS');
  assert.equal(isInsideRoot(base, path.resolve('/projects/PS/services/a')), true);
  assert.equal(isInsideRoot(base, base), true);
  assert.equal(isInsideRoot(base, path.resolve('/projects/PS-evil')), false);
  assert.equal(isInsideRoot(base, path.resolve('/projects')), false);
});

// ── resolveServicePaths (валидация контракта до запуска) ──────────────────────

test('resolveServicePaths: требует абсолютный projectsRoot', () => {
  assert.throws(
    () => resolveServicePaths(claim({ serviceRel: 'a', serviceId: 's1' }).pipeline, { projectsRoot: 'relative' }),
    (e) => e instanceof PipelineTaskError && e.code === 'pipeline_projects_root_required',
  );
});

test('resolveServicePaths: отсутствие serviceId → pipeline_service_required', () => {
  const c = claim({ serviceRel: 'a', serviceId: '' });
  assert.throws(
    () => resolveServicePaths(c.pipeline, { projectsRoot: path.resolve('/projects') }),
    (e) => e instanceof PipelineTaskError && e.code === 'pipeline_service_required',
  );
});

test('resolveServicePaths: path traversal в repositoryPath → path_escape', () => {
  const c = claim({ serviceRel: '../../etc', serviceId: 's1' });
  assert.throws(
    () => resolveServicePaths(c.pipeline, { projectsRoot: path.resolve('/projects') }),
    (e) => e instanceof PipelineTaskError && e.code === 'pipeline_service_path_escape',
  );
});

test('resolveServicePaths: успех даёт абсолютные пути внутри корня', () => {
  const root = path.resolve('/projects');
  const r = resolveServicePaths(claim({ serviceRel: 'services/catalog', serviceId: 's1' }).pipeline, {
    projectsRoot: root,
  });
  assert.equal(r.serviceId, 's1');
  assert.equal(r.absProjectRoot, path.join(root, 'PS'));
  assert.equal(r.absWorkingDirectory, path.join(root, 'PS', 'services', 'catalog'));
  assert.equal(r.absConfigPath, path.join(root, 'PS', 'services', 'catalog', '.pipeline.json'));
});

// ── Полный прогон сервисного этапа ────────────────────────────────────────────

test('запуск сервиса A: выполняются все действия, без единого AI-вызова', async (t) => {
  const root = tmpDir(t);
  writeService(root, 'PS', 'services/catalog', {
    name: 'Catalog_Service',
    stages: { test: ['cmd_test'], build: ['cmd_build'] },
  });

  const executor = new FakeExecutor();
  const task = new ServicePipelineTask({
    projectsRoot: root,
    createRunner: fakeRunnerFactory(executor),
    // умышленно «протаскиваем» tripwire — он не должен использоваться слоем
    aiConnector: aiTripwire(),
  });

  const result = await task.run(claim({ serviceRel: 'services/catalog', serviceId: 'svc-A', serviceName: 'Catalog Service' }));

  assert.equal(result.success, true);
  assert.equal(result.roleCode, 'PIPELINE_SERVICE');
  assert.equal(result.taskId, 'task-1');

  // Все объявленные команды выполнены ровно один раз.
  const ran = executor.calls.map((c) => c.command);
  assert.deepEqual(ran, ['cmd_test', 'cmd_build']);

  // Идентичность сервиса присутствует в summary.
  assert.equal(result.output.summary.serviceId, 'svc-A');
  assert.equal(result.output.summary.serviceName, 'Catalog Service');
  assert.equal(result.output.summary.projectId, 'proj-uuid');

  // Структурированные действия: статус/exitCode/длительность на каждую команду.
  const actions = result.output.summary.actions;
  assert.equal(actions.length, 2);
  for (const a of actions) {
    assert.equal(a.status, 'success');
    assert.equal(a.exitCode, 0);
    assert.equal(typeof a.durationMs, 'number');
  }
  assert.equal(result.output.failedStage, null);
  assert.ok(result.output.startedAt);
});

test('падение команды → success=false, failedStage, переход в failure (по контракту)', async (t) => {
  const root = tmpDir(t);
  writeService(root, 'PS', 'services/catalog', {
    name: 'Catalog_Service',
    stages: { test: ['ok'], build: ['boom'], deploy: ['never'] },
  });

  const executor = new FakeExecutor({ boom: { exitCode: 1 } });
  const task = new ServicePipelineTask({ projectsRoot: root, createRunner: fakeRunnerFactory(executor) });
  const result = await task.run(claim({ serviceRel: 'services/catalog', serviceId: 'svc-A' }));

  assert.equal(result.success, false);
  assert.equal(result.output.failedStage, 'build');
  // deploy не выполнялся (fail-fast).
  assert.ok(!executor.calls.find((c) => c.command === 'never'));
  const failedAction = result.output.summary.actions.find((a) => a.status === 'failed');
  assert.equal(failedAction.exitCode, 1);
});

test('выбор сервиса по serviceId: запускается A, скрипты B не трогаются', async (t) => {
  const root = tmpDir(t);
  // Два различимых сервиса с разными командами.
  writeService(root, 'PS', 'services/a', { name: 'A', stages: { test: ['CMD_A'] } });
  writeService(root, 'PS', 'services/b', { name: 'B', stages: { test: ['CMD_B'] } });

  const executor = new FakeExecutor();
  const task = new ServicePipelineTask({ projectsRoot: root, createRunner: fakeRunnerFactory(executor) });

  const result = await task.run(claim({ serviceRel: 'services/a', serviceId: 'svc-A', serviceName: 'A' }));

  assert.equal(result.success, true);
  const ran = executor.calls.map((c) => c.command);
  assert.deepEqual(ran, ['CMD_A']);
  // Команда сервиса B не запускалась.
  assert.ok(!ran.includes('CMD_B'));
  assert.equal(result.output.summary.serviceName, 'A');
});

test('неизвестный/удалённый сервис: нет serviceId → ошибка до запуска команд', async (t) => {
  const root = tmpDir(t);
  writeService(root, 'PS', 'services/a', { name: 'A', stages: { test: ['CMD_A'] } });
  const executor = new FakeExecutor();
  const task = new ServicePipelineTask({ projectsRoot: root, createRunner: fakeRunnerFactory(executor) });

  const result = await task.run(claim({ serviceRel: 'services/a', serviceId: '' }));

  assert.equal(result.success, false);
  assert.equal(result.output.summary.error.code, 'pipeline_service_required');
  // НИ ОДНА команда не запускалась.
  assert.equal(executor.calls.length, 0);
});

test('сервис без .pipeline.json и без compose: диагностируемая ошибка стадии deploy', async (t) => {
  const root = tmpDir(t);
  // Каталог сервиса есть, но нет ни тестов, ни compose вверх — подсистему для
  // build/deploy определить нельзя (конвенция → ConventionError deploy).
  mkdirSync(path.join(root, 'PS', 'services', 'ghost'), { recursive: true });
  const executor = new FakeExecutor();
  const task = new ServicePipelineTask({ projectsRoot: root, createRunner: fakeRunnerFactory(executor) });

  const result = await task.run(claim({ serviceRel: 'services/ghost', serviceId: 'svc-ghost' }));

  assert.equal(result.success, false);
  assert.equal(result.output.summary.error.code, 'pipeline_compose_not_found');
  assert.equal(result.output.failedStage, 'deploy');
  // Ошибка построения конвенции до запуска — ни одна команда не стартовала.
  assert.equal(executor.calls.length, 0);
});

// ── Конвенционный режим (без локального .pipeline.json) ───────────────────────

/** Создать каталог (рекурсивно) и вернуть его абсолютный путь. */
function makeDir(...p) {
  const dir = path.join(...p);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('конвенция: go-сервис без .pipeline.json → go test → compose build → up -d', async (t) => {
  const root = tmpDir(t);
  const subsystem = makeDir(root, 'PS', 'PS-Torg');
  const service = makeDir(subsystem, 'services', 'catalog');
  writeFileSync(path.join(service, 'go.mod'), 'module catalog\n');
  // compose без healthcheck → smoke пропускается
  writeFileSync(path.join(subsystem, 'docker-compose.yml'), 'services:\n  catalog:\n    build: .\n');

  const executor = new FakeExecutor();
  const task = new ServicePipelineTask({ projectsRoot: root, createRunner: fakeRunnerFactory(executor) });
  const result = await task.run(
    claim({ projectRel: 'PS', serviceRel: 'PS-Torg/services/catalog', serviceId: 'svc-cat', serviceName: 'Catalog' }),
  );

  assert.equal(result.success, true);
  const rel = '../../docker-compose.yml';
  assert.deepEqual(executor.calls.map((c) => c.command), [
    'go test ./...',
    `docker compose -f "${rel}" build`,
    `docker compose -f "${rel}" up -d`,
  ]);
  // В репозитории сервиса НЕ появился .pipeline.json (конвенция, без файла на диске).
  assert.equal(existsSync(path.join(service, '.pipeline.json')), false);
});

test('конвенция: node-сервис с healthcheck → npm test → build → up -d → smoke (--wait)', async (t) => {
  const root = tmpDir(t);
  const projectRoot = makeDir(root, 'PS');
  const service = makeDir(projectRoot, 'web');
  writeFileSync(path.join(service, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  writeFileSync(
    path.join(projectRoot, 'docker-compose.yml'),
    'services:\n  web:\n    image: web\n    healthcheck:\n      test: ["CMD", "true"]\n',
  );

  const executor = new FakeExecutor();
  const task = new ServicePipelineTask({ projectsRoot: root, createRunner: fakeRunnerFactory(executor) });
  const result = await task.run(claim({ projectRel: 'PS', serviceRel: 'web', serviceId: 'svc-web', serviceName: 'Web' }));

  assert.equal(result.success, true);
  const rel = '../docker-compose.yml';
  assert.deepEqual(executor.calls.map((c) => c.command), [
    'npm test',
    `docker compose -f "${rel}" build`,
    `docker compose -f "${rel}" up -d`,
    `docker compose -f "${rel}" up -d --wait`,
  ]);
});

test('конвенция: сервис без тестов → стадия test SKIPPED (no_tests_detected)', async (t) => {
  const root = tmpDir(t);
  const projectRoot = makeDir(root, 'PS');
  const service = makeDir(projectRoot, 'infra');
  writeFileSync(path.join(projectRoot, 'docker-compose.yml'), 'services:\n  x:\n    image: x\n');

  const executor = new FakeExecutor();
  const task = new ServicePipelineTask({ projectsRoot: root, createRunner: fakeRunnerFactory(executor) });
  const result = await task.run(claim({ projectRel: 'PS', serviceRel: 'infra', serviceId: 'svc-infra' }));

  assert.equal(result.success, true);
  const rel = '../docker-compose.yml';
  // Тесты не запускались, но build/deploy — да.
  assert.deepEqual(executor.calls.map((c) => c.command), [
    `docker compose -f "${rel}" build`,
    `docker compose -f "${rel}" up -d`,
  ]);
  const testAction = result.output.summary.actions.find((a) => a.stage === 'test');
  assert.equal(testAction.status, 'SKIPPED');
  assert.equal(testAction.reason, 'no_tests_detected');
});

test('override: локальный .pipeline.json целиком заменяет конвенцию', async (t) => {
  const root = tmpDir(t);
  const projectRoot = makeDir(root, 'PS');
  const service = makeDir(projectRoot, 'svc');
  writeFileSync(path.join(service, 'go.mod'), 'module svc\n'); // конвенция дала бы go test + docker
  writeFileSync(path.join(projectRoot, 'docker-compose.yml'), 'services:\n  x:\n    image: x\n');
  writeFileSync(
    path.join(service, '.pipeline.json'),
    JSON.stringify({ name: 'Custom', stages: { only: { commands: ['CUSTOM_CMD'], enabled: true } } }),
  );

  const executor = new FakeExecutor();
  const task = new ServicePipelineTask({ projectsRoot: root, createRunner: fakeRunnerFactory(executor) });
  const result = await task.run(claim({ projectRel: 'PS', serviceRel: 'svc', serviceId: 'svc-1' }));

  assert.equal(result.success, true);
  // Только команда локального конфига — конвенция не подмешана.
  assert.deepEqual(executor.calls.map((c) => c.command), ['CUSTOM_CMD']);
});

test('override: extendsConvention переопределяет стадию точечно, остальное — из конвенции', async (t) => {
  const root = tmpDir(t);
  const projectRoot = makeDir(root, 'PS');
  const service = makeDir(projectRoot, 'svc');
  writeFileSync(path.join(service, 'go.mod'), 'module svc\n');
  writeFileSync(path.join(projectRoot, 'docker-compose.yml'), 'services:\n  x:\n    image: x\n');
  writeFileSync(
    path.join(service, '.pipeline.json'),
    JSON.stringify({
      extendsConvention: true,
      stages: {
        test: { commands: ['go test -race ./...'], enabled: true }, // переопределяем test
        deploy: { commands: [], enabled: false }, // отключаем deploy
      },
    }),
  );

  const executor = new FakeExecutor();
  const task = new ServicePipelineTask({ projectsRoot: root, createRunner: fakeRunnerFactory(executor) });
  const result = await task.run(claim({ projectRel: 'PS', serviceRel: 'svc', serviceId: 'svc-1' }));

  assert.equal(result.success, true);
  const rel = '../docker-compose.yml';
  // test — из override, build — из конвенции, deploy — отключён (не запускается).
  assert.deepEqual(executor.calls.map((c) => c.command), [
    'go test -race ./...',
    `docker compose -f "${rel}" build`,
  ]);
});

test('path traversal в claim: выход за корень → ошибка до команд', async (t) => {
  const root = tmpDir(t);
  writeService(root, 'PS', 'services/a', { name: 'A', stages: { test: ['CMD_A'] } });
  const executor = new FakeExecutor();
  const task = new ServicePipelineTask({ projectsRoot: root, createRunner: fakeRunnerFactory(executor) });

  const result = await task.run(claim({ serviceRel: '../../../etc', serviceId: 'svc-x' }));

  assert.equal(result.success, false);
  assert.equal(result.output.summary.error.code, 'pipeline_service_path_escape');
  assert.equal(executor.calls.length, 0);
});

test('конфиг с workingDirectory наружу проекта: блокируется, команды не запускаются', async (t) => {
  const root = tmpDir(t);
  // .pipeline.json пытается увести рабочую директорию за пределы проекта
  writeService(root, 'PS', 'services/a', {
    name: 'A',
    workingDirectory: '../../../',
    stages: { test: ['CMD_A'] },
  });
  const executor = new FakeExecutor();
  const task = new ServicePipelineTask({ projectsRoot: root, createRunner: fakeRunnerFactory(executor) });

  const result = await task.run(claim({ serviceRel: 'services/a', serviceId: 'svc-A' }));

  assert.equal(result.success, false);
  assert.equal(result.output.summary.error.code, 'pipeline_service_path_escape');
  assert.equal(executor.calls.length, 0);
});

test('runServicePipeline-обёртка работает идентично классу', async (t) => {
  const root = tmpDir(t);
  writeService(root, 'PS', 'services/a', { name: 'A', stages: { test: ['CMD_A'] } });
  const executor = new FakeExecutor();
  const result = await runServicePipeline(claim({ serviceRel: 'services/a', serviceId: 'svc-A' }), {
    projectsRoot: root,
    createRunner: fakeRunnerFactory(executor),
  });
  assert.equal(result.success, true);
  assert.equal(result.roleCode, 'PIPELINE_SERVICE');
});

test('структурированный результат соответствует контракту host-task-completed', async (t) => {
  const root = tmpDir(t);
  writeService(root, 'PS', 'services/a', { name: 'A', stages: { test: ['CMD_A'] } });
  const executor = new FakeExecutor();
  const task = new ServicePipelineTask({ projectsRoot: root, createRunner: fakeRunnerFactory(executor) });
  const result = await task.run(claim({ serviceRel: 'services/a', serviceId: 'svc-A' }));

  // Верхний уровень DTO.
  assert.deepEqual(Object.keys(result).sort(), ['output', 'roleCode', 'success', 'taskId'].sort());
  // output по контракту: summary / failedStage / startedAt / logPath.
  for (const k of ['summary', 'failedStage', 'startedAt', 'logPath']) {
    assert.ok(k in result.output, `output должен содержать ${k}`);
  }
});

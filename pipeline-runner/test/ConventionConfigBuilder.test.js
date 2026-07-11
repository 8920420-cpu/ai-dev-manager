import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  ConventionConfigBuilder,
  ConventionError,
  mergeConvention,
  detectTestStage,
  findNestedTestRoots,
  findComposeUp,
  composeHasHealthcheck,
  CONVENTION_CONFIG_MARKER,
} from '../src/ConventionConfigBuilder.js';
import { tmpDir } from './helpers.js';

/**
 * Юнит-тесты конвенционного построителя конфига (PIPELINE-CONVENTION-ENGINE-001):
 * детекция стадии тестов по стеку, поиск ближайшего compose с изоляцией по
 * projectRoot, детекция healthcheck, сборка полного набора стадий и постадийное
 * переопределение (mergeConvention).
 */

/** Создать каталог (рекурсивно), вернуть абсолютный путь. */
function mkdir(...p) {
  const dir = path.join(...p);
  mkdirSync(dir, { recursive: true });
  return dir;
}
/** Записать файл, создав родителя при необходимости. */
function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// ── detectTestStage ──────────────────────────────────────────────────────────

test('detectTestStage: go.mod → go test ./...', (t) => {
  const dir = tmpDir(t);
  write(path.join(dir, 'go.mod'), 'module x\n');
  assert.deepEqual(detectTestStage(dir), { name: 'test', commands: ['go test ./...'], enabled: true });
});

test('detectTestStage: package.json со скриптом test → npm test', (t) => {
  const dir = tmpDir(t);
  write(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  assert.deepEqual(detectTestStage(dir), { name: 'test', commands: ['npm test'], enabled: true });
});

test('detectTestStage: package.json без test-скрипта → SKIPPED', (t) => {
  const dir = tmpDir(t);
  write(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
  const s = detectTestStage(dir);
  assert.equal(s.enabled, false);
  assert.equal(s.reason, 'no_tests_detected');
});

test('detectTestStage: нет ни go.mod, ни package.json → SKIPPED с пометкой', (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(detectTestStage(dir), {
    name: 'test',
    commands: [],
    enabled: false,
    reason: 'no_tests_detected',
  });
});

test('detectTestStage: go.mod имеет приоритет над package.json', (t) => {
  const dir = tmpDir(t);
  write(path.join(dir, 'go.mod'), 'module x\n');
  write(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  assert.deepEqual(detectTestStage(dir).commands, ['go test ./...']);
});

// ── detectTestStage: вложенные тест-корни (каталог-обёртка) ───────────────────

test('detectTestStage: пакет с тестами в подкаталоге → npm --prefix <sub> test', (t) => {
  const dir = tmpDir(t); // сам каталог-обёртка без package.json
  write(path.join(dir, 'backend', 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const s = detectTestStage(dir);
  assert.equal(s.enabled, true);
  assert.deepEqual(s.commands, ['npm --prefix "backend" test']);
  assert.deepEqual(s.nestedRoots, ['backend']);
});

test('detectTestStage: go-модуль в подкаталоге → go -C <sub> test ./...', (t) => {
  const dir = tmpDir(t);
  write(path.join(dir, 'server', 'go.mod'), 'module srv\n');
  const s = detectTestStage(dir);
  assert.equal(s.enabled, true);
  assert.deepEqual(s.commands, ['go -C "server" test ./...']);
});

test('detectTestStage: несколько корней на одном уровне → все команды, приоритет backend', (t) => {
  const dir = tmpDir(t);
  write(path.join(dir, 'web', 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  write(path.join(dir, 'backend', 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const s = detectTestStage(dir);
  // backend по приоритету идёт первым, web — по алфавиту.
  assert.deepEqual(s.commands, ['npm --prefix "backend" test', 'npm --prefix "web" test']);
  assert.deepEqual(s.nestedRoots, ['backend', 'web']);
});

test('detectTestStage: ближайший уровень «выигрывает», глубже не спускаемся', (t) => {
  const dir = tmpDir(t);
  // Корень на глубине 1 (backend) и на глубине 2 (backend/sub) — берём только глубину 1.
  write(path.join(dir, 'backend', 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  write(path.join(dir, 'backend', 'sub', 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  const s = detectTestStage(dir);
  assert.deepEqual(s.nestedRoots, ['backend']);
});

test('detectTestStage: package.json в node_modules НЕ считается тест-корнем', (t) => {
  const dir = tmpDir(t);
  write(
    path.join(dir, 'node_modules', 'dep', 'package.json'),
    JSON.stringify({ scripts: { test: 'vitest' } }),
  );
  const s = detectTestStage(dir);
  assert.equal(s.enabled, false);
  assert.equal(s.reason, 'no_tests_detected');
});

test('detectTestStage: подкаталог с package.json без test-скрипта → SKIPPED', (t) => {
  const dir = tmpDir(t);
  write(path.join(dir, 'backend', 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
  const s = detectTestStage(dir);
  assert.equal(s.enabled, false);
  assert.equal(s.reason, 'no_tests_detected');
});

test('findNestedTestRoots: пустой каталог → []', (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(findNestedTestRoots(dir), []);
});

// ── findComposeUp ────────────────────────────────────────────────────────────

test('findComposeUp: находит ближайший compose вверх (подсистема)', (t) => {
  const root = tmpDir(t);
  const projectRoot = mkdir(root, 'PS');
  const subsystem = mkdir(projectRoot, 'PS-Torg');
  const service = mkdir(subsystem, 'services', 'catalog');
  write(path.join(subsystem, 'docker-compose.yml'), 'services: {}\n');
  assert.equal(findComposeUp(service, projectRoot), path.join(subsystem, 'docker-compose.yml'));
});

test('findComposeUp: не поднимается выше projectRoot', (t) => {
  const root = tmpDir(t);
  const projectRoot = mkdir(root, 'PS');
  const service = mkdir(projectRoot, 'services', 'catalog');
  // compose лежит ВЫШЕ корня проекта — не должен найтись (изоляция).
  write(path.join(root, 'docker-compose.yml'), 'services: {}\n');
  assert.equal(findComposeUp(service, projectRoot), null);
});

test('findComposeUp: compose в самом каталоге сервиса', (t) => {
  const root = tmpDir(t);
  const projectRoot = mkdir(root, 'PS');
  const service = mkdir(projectRoot, 'svc');
  write(path.join(service, 'compose.yaml'), 'services: {}\n');
  assert.equal(findComposeUp(service, projectRoot), path.join(service, 'compose.yaml'));
});

// ── composeHasHealthcheck ────────────────────────────────────────────────────

test('composeHasHealthcheck: true при объявленном healthcheck, false без него', (t) => {
  const dir = tmpDir(t);
  const withHc = path.join(dir, 'a.yml');
  write(withHc, 'services:\n  web:\n    image: x\n    healthcheck:\n      test: ["CMD","true"]\n');
  const noHc = path.join(dir, 'b.yml');
  write(noHc, 'services:\n  web:\n    image: x\n');
  assert.equal(composeHasHealthcheck(withHc), true);
  assert.equal(composeHasHealthcheck(noHc), false);
});

test('composeHasHealthcheck: настоящий healthcheck → true', (t) => {
  const dir = tmpDir(t);
  const p = path.join(dir, 'real.yml');
  write(p, 'services:\n  web:\n    image: x\n    healthcheck:\n      test: ["CMD","true"]\n');
  assert.equal(composeHasHealthcheck(p), true);
});

test('composeHasHealthcheck: только закомментированный # healthcheck: → false', (t) => {
  const dir = tmpDir(t);
  const p = path.join(dir, 'commented.yml');
  write(p, 'services:\n  web:\n    image: x\n    # healthcheck:\n    #   test: ["CMD","true"]\n');
  assert.equal(composeHasHealthcheck(p), false);
});

test('composeHasHealthcheck: healthcheck с хвостовым инлайн-комментарием → true', (t) => {
  const dir = tmpDir(t);
  const p = path.join(dir, 'inline.yml');
  write(p, 'services:\n  web:\n    image: x\n    healthcheck:  # ждём healthy\n      test: ["CMD","true"]\n');
  assert.equal(composeHasHealthcheck(p), true);
});

// ── build (полный набор стадий) ──────────────────────────────────────────────

test('build: go-сервис + compose с healthcheck → test/build/deploy/smoke', (t) => {
  const root = tmpDir(t);
  const projectRoot = mkdir(root, 'PS');
  const subsystem = mkdir(projectRoot, 'PS-Torg');
  const service = mkdir(subsystem, 'services', 'catalog');
  write(path.join(service, 'go.mod'), 'module catalog\n');
  write(
    path.join(subsystem, 'docker-compose.yml'),
    'services:\n  catalog:\n    build: .\n    healthcheck:\n      test: ["CMD","true"]\n',
  );

  const cfg = new ConventionConfigBuilder().build({ serviceDir: service, projectRoot, name: 'Catalog' });

  assert.equal(cfg.name, 'Catalog');
  assert.equal(cfg.workingDirectory, path.resolve(service));
  assert.equal(cfg.configPath, CONVENTION_CONFIG_MARKER);
  assert.deepEqual(cfg.stages.map((s) => s.name), ['test', 'build', 'deploy', 'smoke']);

  const rel = '../../docker-compose.yml';
  const byName = Object.fromEntries(cfg.stages.map((s) => [s.name, s]));
  assert.deepEqual(byName.test.commands, ['go test ./...']);
  assert.deepEqual(byName.build.commands, [`docker compose -f "${rel}" build`]);
  assert.deepEqual(byName.deploy.commands, [`docker compose -f "${rel}" up -d`]);
  assert.equal(byName.smoke.enabled, true);
  assert.deepEqual(byName.smoke.commands, [`docker compose -f "${rel}" up -d --wait`]);
});

test('build: node-сервис + compose без healthcheck → smoke SKIPPED', (t) => {
  const root = tmpDir(t);
  const projectRoot = mkdir(root, 'PS');
  const service = mkdir(projectRoot, 'web');
  write(path.join(service, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  write(path.join(projectRoot, 'docker-compose.yml'), 'services:\n  web:\n    image: x\n');

  const cfg = new ConventionConfigBuilder().build({ serviceDir: service, projectRoot });
  const byName = Object.fromEntries(cfg.stages.map((s) => [s.name, s]));
  const rel = '../docker-compose.yml';
  assert.deepEqual(byName.test.commands, ['npm test']);
  assert.deepEqual(byName.build.commands, [`docker compose -f "${rel}" build`]);
  assert.equal(byName.smoke.enabled, false);
  assert.equal(byName.smoke.reason, 'no_healthcheck_in_compose');
});

test('build: сервис без тестов + compose → test SKIPPED, build/deploy собраны', (t) => {
  const root = tmpDir(t);
  const projectRoot = mkdir(root, 'PS');
  const service = mkdir(projectRoot, 'infra');
  write(path.join(projectRoot, 'docker-compose.yml'), 'services:\n  x:\n    image: x\n');

  const cfg = new ConventionConfigBuilder().build({ serviceDir: service, projectRoot });
  const byName = Object.fromEntries(cfg.stages.map((s) => [s.name, s]));
  assert.equal(byName.test.enabled, false);
  assert.equal(byName.test.reason, 'no_tests_detected');
  assert.equal(byName.build.enabled, true);
  assert.equal(byName.deploy.enabled, true);
});

test('build: нет compose до корня → ConventionError(pipeline_compose_not_found)', (t) => {
  const root = tmpDir(t);
  const projectRoot = mkdir(root, 'PS');
  const service = mkdir(projectRoot, 'services', 'catalog');
  write(path.join(service, 'go.mod'), 'module x\n');
  assert.throws(
    () => new ConventionConfigBuilder().build({ serviceDir: service, projectRoot }),
    (e) => e instanceof ConventionError && e.code === 'pipeline_compose_not_found',
  );
});

test('build: имя по умолчанию pipeline, если name не задан', (t) => {
  const root = tmpDir(t);
  const projectRoot = mkdir(root, 'PS');
  const service = mkdir(projectRoot, 'svc');
  write(path.join(projectRoot, 'docker-compose.yml'), 'services:\n  x:\n    image: x\n');
  const cfg = new ConventionConfigBuilder().build({ serviceDir: service, projectRoot });
  assert.equal(cfg.name, 'pipeline');
});

// ── mergeConvention ──────────────────────────────────────────────────────────

test('mergeConvention: локальный этап переопределяет конвенционный, новый добавляется', () => {
  const convention = {
    name: 'Svc',
    workingDirectory: path.resolve('/w'),
    timeoutMinutes: null,
    configPath: CONVENTION_CONFIG_MARKER,
    stages: [
      { name: 'test', commands: ['go test ./...'], enabled: true },
      { name: 'build', commands: ['docker compose -f "x" build'], enabled: true },
      { name: 'deploy', commands: ['docker compose -f "x" up -d'], enabled: true },
    ],
  };
  const override = {
    name: 'pipeline', // дефолт ConfigLoader → имя берётся из конвенции
    workingDirectory: path.resolve('/w'),
    timeoutMinutes: 10,
    configPath: path.resolve('/w/.pipeline.json'),
    stages: [
      { name: 'test', commands: ['go test -race ./...'], enabled: true },
      { name: 'lint', commands: ['golangci-lint run'], enabled: true },
    ],
  };

  const merged = mergeConvention(convention, override);
  assert.equal(merged.name, 'Svc');
  assert.equal(merged.timeoutMinutes, 10);
  assert.deepEqual(merged.stages.map((s) => s.name), ['test', 'build', 'deploy', 'lint']);
  assert.deepEqual(merged.stages.find((s) => s.name === 'test').commands, ['go test -race ./...']);
  // build/deploy сохранились из конвенции.
  assert.deepEqual(merged.stages.find((s) => s.name === 'build').commands, ['docker compose -f "x" build']);
});

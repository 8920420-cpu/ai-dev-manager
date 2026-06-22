import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScannerSupervisor } from '../src/ScannerSupervisor.js';
import { TaskScanner } from '../src/TaskScanner.js';
import { SCANNER_READY_CODE } from '../src/paths.js';

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'sup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  return { root, stateDir };
}

async function dir(root, name) {
  const d = join(root, name);
  await mkdir(d, { recursive: true });
  return d;
}

const doc = (tasks) => `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`;
const done = (id, service = 'Svc') => ({ id, project: 'PS', service, title: 'X', status: 'done' });

function makeSupervisor({ provider, received, stateDir, log }) {
  const buildScanner = (config) =>
    new TaskScanner({
      watchDirectory: config.watchDirectory,
      documentName: config.documentName,
      statePath: join(stateDir, `${config.projectId}__${config.stageId}.json`),
      projectId: config.projectId,
      stageId: config.stageId,
      fallbackMs: 0,
      debounceMs: 10,
      dispatch: async (p) => received.push(p),
    });
  return new ScannerSupervisor({ provider, buildScanner, intervalMs: 100_000, log: log ?? silentLog() });
}

const silentLog = () => ({ error() {}, warn() {}, info() {} });

async function waitFor(predicate, { timeoutMs = 2000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('Условие не выполнено за отведённое время');
}

test('включённый Scanner замечает свой документ и отправляет completion с projectId/stageId', async (t) => {
  const { root, stateDir } = await workspace(t);
  const wdir = await dir(root, 'ps-tasks');
  const received = [];
  const provider = async () => [{ projectId: 'ps', stageId: 'st1', watchDirectory: wdir, documentName: 'claude-tasks.json' }];
  const sup = makeSupervisor({ provider, received, stateDir });
  await sup.refresh();
  t.after(() => sup.stop());

  await writeFile(join(wdir, 'claude-tasks.json'), doc([done('t-1')]), 'utf8');
  await waitFor(() => received.length === 1);
  assert.equal(received[0].taskId, 't-1');
  assert.equal(received[0].projectId, 'ps');
  assert.equal(received[0].stageId, 'st1');
});

test('два проекта наблюдают разные каталоги без перекрёстных событий', async (t) => {
  const { root, stateDir } = await workspace(t);
  const a = await dir(root, 'ps-tasks');
  const b = await dir(root, 'orch-tasks');
  const received = [];
  const provider = async () => [
    { projectId: 'ps', stageId: 'sa', watchDirectory: a, documentName: 'claude-tasks.json' },
    { projectId: 'orch', stageId: 'sb', watchDirectory: b, documentName: 'claude-tasks.json' },
  ];
  const sup = makeSupervisor({ provider, received, stateDir });
  await sup.refresh();
  t.after(() => sup.stop());

  await writeFile(join(a, 'claude-tasks.json'), doc([done('only-a')]), 'utf8');
  await waitFor(() => received.length === 1);
  assert.equal(received[0].taskId, 'only-a');
  assert.equal(received[0].projectId, 'ps');
  // Событие в каталоге A не порождает completion для проекта orch.
  assert.ok(!received.some((r) => r.projectId === 'orch'));
});

test('exactly-once: повторный refresh не дублирует доставку', async (t) => {
  const { root, stateDir } = await workspace(t);
  const wdir = await dir(root, 'ps-tasks');
  const received = [];
  const provider = async () => [{ projectId: 'ps', stageId: 's', watchDirectory: wdir, documentName: 'claude-tasks.json' }];
  const sup = makeSupervisor({ provider, received, stateDir });
  await sup.refresh();
  t.after(() => sup.stop());
  await writeFile(join(wdir, 'claude-tasks.json'), doc([done('t-1')]), 'utf8');
  await waitFor(() => received.length === 1);
  // Тот же конфиг — watcher не пересоздаётся, повторной доставки нет.
  const summary = await sup.reconcile(await provider());
  assert.deepEqual(summary.unchanged, ['ps::s']);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(received.length, 1);
});

test('отключение этапа останавливает watcher и прекращает доставку', async (t) => {
  const { root, stateDir } = await workspace(t);
  const wdir = await dir(root, 'ps-tasks');
  const received = [];
  let enabled = true;
  const provider = async () =>
    enabled ? [{ projectId: 'ps', stageId: 's', watchDirectory: wdir, documentName: 'claude-tasks.json' }] : [];
  const sup = makeSupervisor({ provider, received, stateDir });
  await sup.refresh();
  t.after(() => sup.stop());

  enabled = false;
  const summary = await sup.refresh();
  assert.deepEqual(summary.removed, ['ps::s']);
  assert.equal(sup.readiness().watchers.length, 0);

  // После остановки запись в документ не порождает completion.
  await writeFile(join(wdir, 'claude-tasks.json'), doc([done('late')]), 'utf8');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(received.length, 0);
});

test('смена папки атомарно переключает watcher на новый каталог', async (t) => {
  const { root, stateDir } = await workspace(t);
  const oldDir = await dir(root, 'old');
  const newDir = await dir(root, 'new');
  const received = [];
  let watchDirectory = oldDir;
  const provider = async () => [{ projectId: 'ps', stageId: 's', watchDirectory, documentName: 'claude-tasks.json' }];
  const sup = makeSupervisor({ provider, received, stateDir });
  await sup.refresh();
  t.after(() => sup.stop());

  watchDirectory = newDir;
  const summary = await sup.refresh();
  assert.deepEqual(summary.switched, ['ps::s']);

  // Новый каталог наблюдается, старый — нет.
  await writeFile(join(newDir, 'claude-tasks.json'), doc([done('in-new')]), 'utf8');
  await waitFor(() => received.length === 1);
  assert.equal(received[0].taskId, 'in-new');

  received.length = 0;
  await writeFile(join(oldDir, 'claude-tasks.json'), doc([done('in-old')]), 'utf8');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(received.length, 0);
});

test('переключение на недоступную папку сохраняет старый рабочий watcher', async (t) => {
  const { root, stateDir } = await workspace(t);
  const oldDir = await dir(root, 'old');
  const missing = join(root, 'does-not-exist');
  const received = [];
  let watchDirectory = oldDir;
  const provider = async () => [{ projectId: 'ps', stageId: 's', watchDirectory, documentName: 'claude-tasks.json' }];
  const sup = makeSupervisor({ provider, received, stateDir });
  await sup.refresh();
  t.after(() => sup.stop());

  watchDirectory = missing;
  const summary = await sup.refresh();
  assert.deepEqual(summary.rejected, ['ps::s']);

  // Старый watcher всё ещё работает — окна потери доставки нет.
  await writeFile(join(oldDir, 'claude-tasks.json'), doc([done('still-old')]), 'utf8');
  await waitFor(() => received.length === 1);
  assert.equal(received[0].taskId, 'still-old');
});

test('недоступная папка при создании → readiness error, watcher не стартует', async (t) => {
  const { root, stateDir } = await workspace(t);
  const missing = join(root, 'nope');
  const received = [];
  const provider = async () => [{ projectId: 'ps', stageId: 's', watchDirectory: missing, documentName: 'claude-tasks.json' }];
  const sup = makeSupervisor({ provider, received, stateDir });
  const summary = await sup.refresh();
  t.after(() => sup.stop());
  assert.deepEqual(summary.rejected, ['ps::s']);
  const r = sup.readiness();
  assert.equal(r.status, 'degraded');
  assert.equal(r.watchers[0].state, 'error');
  assert.equal(r.watchers[0].code, SCANNER_READY_CODE.WATCH_DIR_UNAVAILABLE);
});

test('конфиг с traversal-именем документа отклоняется без watcher', async (t) => {
  const { root, stateDir } = await workspace(t);
  const wdir = await dir(root, 'ps-tasks');
  const received = [];
  const provider = async () => [{ projectId: 'ps', stageId: 's', watchDirectory: wdir, documentName: '../escape.json' }];
  const sup = makeSupervisor({ provider, received, stateDir });
  const summary = await sup.refresh();
  t.after(() => sup.stop());
  assert.deepEqual(summary.rejected, ['ps::s']);
  assert.equal(sup.readiness().watchers[0].code, SCANNER_READY_CODE.DOCUMENT_PATH_ESCAPE);
});

test('сбой провайдера сохраняет текущие watcher', async (t) => {
  const { root, stateDir } = await workspace(t);
  const wdir = await dir(root, 'ps-tasks');
  const received = [];
  let fail = false;
  const provider = async () => {
    if (fail) throw new Error('orchestrator down');
    return [{ projectId: 'ps', stageId: 's', watchDirectory: wdir, documentName: 'claude-tasks.json' }];
  };
  const sup = makeSupervisor({ provider, received, stateDir });
  await sup.refresh();
  t.after(() => sup.stop());
  assert.equal(sup.readiness().watchers.length, 1);

  fail = true;
  const summary = await sup.refresh();
  assert.equal(summary.skipped, true);
  assert.equal(summary.reason, 'provider_failed');
  // Watcher сохранён и продолжает работать.
  assert.equal(sup.readiness().watchers[0].state, 'watching');
  await writeFile(join(wdir, 'claude-tasks.json'), doc([done('survives')]), 'utf8');
  await waitFor(() => received.length === 1);
});

test('изоляция exactly-once state: одинаковый task id в двух проектах доставляется обоими', async (t) => {
  const { root, stateDir } = await workspace(t);
  const a = await dir(root, 'a');
  const b = await dir(root, 'b');
  const received = [];
  const provider = async () => [
    { projectId: 'pa', stageId: 's', watchDirectory: a, documentName: 'claude-tasks.json' },
    { projectId: 'pb', stageId: 's', watchDirectory: b, documentName: 'claude-tasks.json' },
  ];
  const sup = makeSupervisor({ provider, received, stateDir });
  await sup.refresh();
  t.after(() => sup.stop());

  await writeFile(join(a, 'claude-tasks.json'), doc([done('shared-id')]), 'utf8');
  await writeFile(join(b, 'claude-tasks.json'), doc([done('shared-id')]), 'utf8');
  await waitFor(() => received.length === 2);
  const projects = received.map((r) => r.projectId).sort();
  assert.deepEqual(projects, ['pa', 'pb']);
});

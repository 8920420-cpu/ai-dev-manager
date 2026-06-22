import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskScanner, parseDocument } from '../src/TaskScanner.js';

async function fixture(t, tasks) {
  const dir = await mkdtemp(join(tmpdir(), 'scanner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const documentPath = join(dir, 'tasks.json');
  const statePath = join(dir, 'state.json');
  await writeFile(documentPath, JSON.stringify({ version: 1, tasks }), 'utf8');
  return { documentPath, statePath };
}

test('передаёт выполненную задачу с проектом и сервисом', async (t) => {
  const paths = await fixture(t, [{
    id: '6f83f7aa-5033-48d9-ac7f-3cd90b31cdf7', project: 'PS', service: 'Chat_Service',
    title: 'Исправить reconnect', status: 'выполнено', result: 'Исправлено', changedFiles: ['src/chat.js'],
  }]);
  const received = [];
  const scanner = new TaskScanner({ ...paths, dispatch: async (p) => received.push(p) });
  const result = await scanner.scanOnce();
  assert.deepEqual(result.dispatched, ['6f83f7aa-5033-48d9-ac7f-3cd90b31cdf7']);
  assert.equal(received[0].service, 'Chat_Service');
  assert.equal(received[0].nextRole, 'TASK_REVIEWER');
});

test('после доставки удаляет завершённую запись, освобождая слот', async (t) => {
  const paths = await fixture(t, [{
    id: '6f83f7aa-5033-48d9-ac7f-3cd90b31cdf7', project: 'PS', service: 'Chat_Service',
    title: 'X', status: 'выполнено', result: 'ok', changedFiles: [],
  }]);
  const scanner = new TaskScanner({ ...paths, dispatch: async () => ({ accepted: true }) });
  const result = await scanner.scanOnce();
  assert.deepEqual(result.cleared, ['6f83f7aa-5033-48d9-ac7f-3cd90b31cdf7']);
  const doc = JSON.parse(await readFile(paths.documentPath, 'utf8'));
  assert.equal(doc.tasks.length, 0);
});

test('clearOnDispatch=false оставляет запись в файле', async (t) => {
  const paths = await fixture(t, [{
    id: 'aa83f7aa-5033-48d9-ac7f-3cd90b31cdf7', project: 'PS', service: 'Chat_Service',
    title: 'X', status: 'выполнено',
  }]);
  const scanner = new TaskScanner({ ...paths, clearOnDispatch: false, dispatch: async () => ({}) });
  await scanner.scanOnce();
  const doc = JSON.parse(await readFile(paths.documentPath, 'utf8'));
  assert.equal(doc.tasks.length, 1);
});

test('очистка сохраняет другие записи и те, что Claude сбросил', async (t) => {
  const paths = await fixture(t, [
    { id: 'd1', project: 'PS', service: 'Chat', title: 'done', status: 'done' },
    { id: 'd2', project: 'PS', service: 'Chat', title: 'wip', status: 'в работе' },
  ]);
  const scanner = new TaskScanner({ ...paths, dispatch: async () => ({}) });
  await scanner.scanOnce();
  const doc = JSON.parse(await readFile(paths.documentPath, 'utf8'));
  assert.deepEqual(doc.tasks.map((t) => t.id), ['d2']);
});

test('не передаёт незавершённую задачу', async (t) => {
  const paths = await fixture(t, [{ id: 'T-1', project: 'PS', service: 'Chat', title: 'X', status: 'в работе' }]);
  let calls = 0;
  const scanner = new TaskScanner({ ...paths, dispatch: async () => calls++ });
  await scanner.scanOnce();
  assert.equal(calls, 0);
});

test('не запускает одну задачу повторно после перезапуска', async (t) => {
  const paths = await fixture(t, [{ id: 'T-1', project: 'PS', service: 'Chat', title: 'X', status: 'done' }]);
  let calls = 0;
  await new TaskScanner({ ...paths, dispatch: async () => calls++ }).scanOnce();
  await new TaskScanner({ ...paths, dispatch: async () => calls++ }).scanOnce();
  assert.equal(calls, 1);
  const state = JSON.parse(await readFile(paths.statePath, 'utf8'));
  assert.ok(state.dispatched['T-1']);
});

test('не фиксирует задачу при ошибке отправки и повторяет её позже', async (t) => {
  const paths = await fixture(t, [{ id: 'T-1', project: 'PS', service: 'Chat', title: 'X', status: 'completed' }]);
  const scanner = new TaskScanner({ ...paths, dispatch: async () => { throw new Error('offline'); } });
  await assert.rejects(() => scanner.scanOnce(), /offline/);
  const recovered = [];
  await new TaskScanner({ ...paths, dispatch: async (p) => recovered.push(p) }).scanOnce();
  assert.equal(recovered.length, 1);
});

test('валидирует версию и уникальность id', () => {
  assert.throws(() => parseDocument('{"version":2,"tasks":[]}'), /version/);
  assert.throws(() => parseDocument('{"version":1,"tasks":[{"id":"T"},{"id":"T"}]}'), /Duplicate/);
});

test('start() реагирует на изменение файла через fs.watch', async (t) => {
  const paths = await fixture(t, []);
  const received = [];
  const scanner = new TaskScanner({
    ...paths,
    fallbackMs: 0, // только fs.watch, без резервного опроса
    debounceMs: 20,
    dispatch: async (p) => received.push(p),
  });
  scanner.start();
  t.after(() => scanner.stop());

  await writeFile(paths.documentPath, JSON.stringify({
    version: 1,
    tasks: [{ id: 'W-1', project: 'PS', service: 'Chat', title: 'X', status: 'done' }],
  }), 'utf8');

  await waitFor(() => received.length === 1);
  assert.equal(received[0].taskId, 'W-1');
});

async function waitFor(predicate, { timeoutMs = 2000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('Условие не выполнено за отведённое время');
}

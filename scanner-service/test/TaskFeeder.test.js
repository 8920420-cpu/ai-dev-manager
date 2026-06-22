import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskFeeder } from '../src/TaskFeeder.js';

async function dir(t) {
  const d = await mkdtemp(join(tmpdir(), 'feeder-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  return join(d, 'tasks.json');
}

const TASK = { id: 'uuid-1', project: 'PS', service: 'Chat_Service', title: 'Сделать X', description: 'детали' };

test('наполняет пустой слот задачей из БД со статусом «готово к работе»', async (t) => {
  const documentPath = await dir(t);
  const feeder = new TaskFeeder({ documentPath, claimNext: async () => ({ task: TASK }) });
  const result = await feeder.feedOnce();
  assert.deepEqual(result, { filled: true, taskId: 'uuid-1' });
  const doc = JSON.parse(await readFile(documentPath, 'utf8'));
  assert.equal(doc.tasks.length, 1);
  assert.equal(doc.tasks[0].status, 'готово к работе');
  assert.equal(doc.tasks[0].service, 'Chat_Service');
  assert.equal(doc.tasks[0].description, 'детали');
});

test('не трогает занятый слот', async (t) => {
  const documentPath = await dir(t);
  await writeFile(documentPath, JSON.stringify({
    version: 1, tasks: [{ id: 'busy', project: 'PS', service: 'Chat', title: 'идёт', status: 'блок' }],
  }), 'utf8');
  let claimed = 0;
  const feeder = new TaskFeeder({ documentPath, claimNext: async () => { claimed++; return { task: TASK }; } });
  assert.deepEqual(await feeder.feedOnce(), { filled: false, reason: 'slot_busy' });
  assert.equal(claimed, 0); // даже не дёргаем БД, если слот занят
});

test('пустой ответ БД — ничего не пишет', async (t) => {
  const documentPath = await dir(t);
  const feeder = new TaskFeeder({ documentPath, claimNext: async () => ({ task: null }) });
  assert.deepEqual(await feeder.feedOnce(), { filled: false, reason: 'no_task' });
});

test('возвращает задачу в пул, если запись файла не удалась', async (t) => {
  const documentPath = await dir(t);
  const released = [];
  const feeder = new TaskFeeder({
    documentPath,
    // claimNext проходит при свободном слоте, но затем занимает путь каталогом —
    // запись (readFile/rename по этому пути) падает, и задача обязана вернуться в пул.
    claimNext: async () => {
      await mkdir(documentPath, { recursive: true });
      return { task: TASK };
    },
    release: async (id) => released.push(id),
  });
  await assert.rejects(() => feeder.feedOnce());
  assert.deepEqual(released, ['uuid-1']);
});

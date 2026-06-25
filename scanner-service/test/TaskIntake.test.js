import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TaskIntake,
  parseQueueFile,
  parseFrontmatter,
  isPickable,
  removeTaskSection,
} from '../src/TaskIntake.js';

async function tasksDir(t) {
  const d = await mkdtemp(join(tmpdir(), 'intake-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

// Очередь сервиса: frontmatter с кодом + секции задач по маркерам.
const QUEUE = (service, ...sections) =>
  `---\nservice: ${service}\n---\n# ${service}\n\nОписание сервиса.\n\n## P0 — ${service}\n\n${sections.join('\n\n')}\n`;
const SECTION = (marker, priority, id, title, body = '') =>
  `### [${marker}] ${priority} ${id} — ${title}\n${body}`;

test('parseFrontmatter: снимает кавычки и читает service', () => {
  assert.equal(parseFrontmatter('---\nservice: "ORCHESTRATOR"\n---\n# x').service, 'ORCHESTRATOR');
  assert.equal(parseFrontmatter('# нет frontmatter').service, undefined);
});

test('parseQueueFile: разбирает service и секции задач с границами', () => {
  const raw = QUEUE('ORCHESTRATOR',
    SECTION(' ', 'P0.1', 'INIT-001', 'первая', 'тело первой'),
    SECTION('x', 'P0.2', 'INIT-002', 'вторая', 'Pre-coding brief:\n\n- пункт\n\nTasks:\n\n- ещё'),
  );
  const { service, tasks } = parseQueueFile(raw);
  assert.equal(service, 'ORCHESTRATOR');
  assert.equal(tasks.length, 2);
  assert.deepEqual(
    tasks.map((tk) => ({ marker: tk.marker, priority: tk.priority, id: tk.id, title: tk.title })),
    [
      { marker: '', priority: 'P0.1', id: 'INIT-001', title: 'первая' },
      { marker: 'x', priority: 'P0.2', id: 'INIT-002', title: 'вторая' },
    ],
  );
  assert.equal(tasks[0].body, 'тело первой');
  assert.equal(tasks[1].body, 'Pre-coding brief:\n\n- пункт\n\nTasks:\n\n- ещё');
});

test('isPickable: только [x] (регистр/пробелы), прочие маркеры — нет', () => {
  assert.equal(isPickable('x'), true);
  assert.equal(isPickable(' X '), true);
  assert.equal(isPickable(''), false);
  assert.equal(isPickable('R'), false);
  assert.equal(isPickable('!'), false);
  assert.equal(isPickable(undefined), false);
});

test('removeTaskSection: вырезает только нужную задачу, остальные сохраняет', () => {
  const raw = QUEUE('SCANNER',
    SECTION(' ', 'P1.1', 'A', 'остаётся', 'тело A'),
    SECTION('x', 'P1.2', 'B', 'уходит', 'тело B'),
    SECTION(' ', 'P1.3', 'C', 'тоже остаётся', 'тело C'),
  );
  const next = removeTaskSection(raw, 'P1.2');
  const { tasks } = parseQueueFile(next);
  assert.deepEqual(tasks.map((tk) => tk.priority), ['P1.1', 'P1.3']);
  assert.ok(!next.includes('уходит'));
  assert.ok(next.includes('остаётся'));
  assert.ok(next.includes('тоже остаётся'));
  assert.ok(next.includes('service: SCANNER'), 'frontmatter сохранён');
});

test('removeTaskSection: нет такой задачи → текст без изменений', () => {
  const raw = QUEUE('SVC', SECTION('x', 'P1.1', 'A', 'one', 'тело'));
  assert.equal(removeTaskSection(raw, 'P9.9'), raw);
});

test('scanOnce: импортирует только [x] и вырезает её из файла', async (t) => {
  const dir = await tasksDir(t);
  await mkdir(join(dir, 'archive'), { recursive: true });
  await writeFile(join(dir, 'README.md'), '# readme', 'utf8');
  await writeFile(join(dir, 'archive', 'old.md'),
    QUEUE('SVC', SECTION('x', 'P9.9', 'OLD', 'архив', 'тело')), 'utf8');
  const queue = join(dir, 'orchestrator-service.md');
  await writeFile(queue, QUEUE('ORCHESTRATOR',
    SECTION(' ', 'P0.1', 'A', 'ещё пишется', 'тело A'),
    SECTION('x', 'P0.2', 'B', 'готова', 'тело B'),
  ), 'utf8');

  const sent = [];
  const intake = new TaskIntake({
    tasksDir: dir,
    project: 'ai-dev-manager',
    intake: async (p) => { sent.push(p); return { taskId: `db-${p.externalId}`, imported: true }; },
    log: { warn() {}, error() {}, info() {} },
  });
  const result = await intake.scanOnce();

  assert.equal(sent.length, 1, 'только [x], не [ ]/README/archive');
  assert.equal(sent[0].externalId, 'ORCHESTRATOR-P0.2');
  assert.equal(sent[0].project, 'ai-dev-manager');
  assert.equal(sent[0].service, 'ORCHESTRATOR');
  assert.equal(sent[0].title, 'готова');
  assert.equal(sent[0].description, 'тело B');
  assert.equal(result.imported.length, 1);

  const after = await readFile(queue, 'utf8');
  assert.ok(!after.includes('P0.2'), 'выполненная задача вырезана из файла');
  assert.ok(after.includes('ещё пишется'), 'невыполненная задача осталась');
});

test('scanOnce: повторный проход не дублирует — задача уже вырезана', async (t) => {
  const dir = await tasksDir(t);
  await writeFile(join(dir, 'svc.md'),
    QUEUE('SVC', SECTION('x', 'P1.1', 'C', 'готова', 'тело')), 'utf8');
  let calls = 0;
  const intake = new TaskIntake({
    tasksDir: dir,
    project: 'p',
    intake: async () => { calls++; return { taskId: 'db-1' }; },
    log: { warn() {}, error() {}, info() {} },
  });
  await intake.scanOnce();
  await intake.scanOnce();
  assert.equal(calls, 1, 'второй проход не находит [x] — задача уже в БД и вырезана');
});

test('scanOnce: очередь без service во frontmatter пропускается', async (t) => {
  const dir = await tasksDir(t);
  await writeFile(join(dir, 'noservice.md'),
    `# noservice\n\n## P1\n\n${SECTION('x', 'P1.1', 'A', 'готова', 'тело')}\n`, 'utf8');
  let calls = 0;
  const intake = new TaskIntake({
    tasksDir: dir,
    project: 'p',
    intake: async () => { calls++; return {}; },
    log: { warn() {}, error() {}, info() {} },
  });
  await intake.scanOnce();
  assert.equal(calls, 0, 'без кода сервиса задачу не отправляем');
});

test('scanOnce: при duplicate от оркестратора секция всё равно вырезается', async (t) => {
  const dir = await tasksDir(t);
  const queue = join(dir, 'svc.md');
  await writeFile(queue, QUEUE('SVC', SECTION('x', 'P2.1', 'D', 'готова', 'тело')), 'utf8');
  const intake = new TaskIntake({
    tasksDir: dir,
    project: 'p',
    intake: async (p) => ({ taskId: 'db-existing', duplicate: true, externalId: p.externalId }),
    log: { warn() {}, error() {}, info() {} },
  });
  const result = await intake.scanOnce();
  assert.equal(result.imported[0].duplicate, true);
  const after = await readFile(queue, 'utf8');
  assert.ok(!after.includes('готова'), 'duplicate тоже очищает файл (идемпотентность)');
});

test('scanOnce: ошибка отправки оставляет задачу в файле для повтора', async (t) => {
  const dir = await tasksDir(t);
  const queue = join(dir, 'svc.md');
  await writeFile(queue, QUEUE('SVC', SECTION('x', 'P3.1', 'E', 'готова', 'тело')), 'utf8');
  const intake = new TaskIntake({
    tasksDir: dir,
    project: 'p',
    intake: async () => { throw new Error('orchestrator 500'); },
    log: { warn() {}, error() {}, info() {} },
  });
  const result = await intake.scanOnce();
  assert.equal(result.imported.length, 0);
  const after = await readFile(queue, 'utf8');
  assert.ok(after.includes('готова'), 'при ошибке задача не теряется');
});

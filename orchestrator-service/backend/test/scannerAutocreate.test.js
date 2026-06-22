import test from 'node:test';
import assert from 'node:assert/strict';
import { findOrCreateScannerTask } from '../src/db.js';

// Мини-клиент pg: отвечает по первому подходящему правилу (regex по SQL).
// reply может быть функцией (hits, params) → { rows, rowCount }.
function fakeClient(rules) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const rule of rules) {
        if (rule.re.test(sql)) {
          rule.hits = (rule.hits ?? 0) + 1;
          const out = typeof rule.reply === 'function' ? rule.reply(rule.hits, params) : rule.reply;
          return out ?? { rows: [], rowCount: 0 };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const payload = {
  taskId: '6f83f7aa-5033-48d9-ac7f-3cd90b31cdf7',
  project: 'PS',
  service: 'Catalog_Service',
  title: 'Новая задача из документа',
};

test('findOrCreateScannerTask: задача уже есть → не создаёт', async () => {
  const c = fakeClient([
    {
      re: /FROM tasks t[\s\S]*FOR UPDATE OF t/,
      reply: { rowCount: 1, rows: [{ id: payload.taskId, status: 'CODING', project_code: 'PS', service_code: 'Catalog_Service', reviewer_role_id: 'rev' }] },
    },
  ]);
  const { task, created } = await findOrCreateScannerTask(c, payload);
  assert.equal(created, false);
  assert.equal(task.id, payload.taskId);
  assert.equal(c.calls.some((q) => /INSERT INTO tasks/.test(q.sql)), false, 'не должно быть INSERT');
});

test('findOrCreateScannerTask: задачи нет → создаёт проект/сервис/задачу', async () => {
  const c = fakeClient([
    // Первый SELECT — пусто, после создания — задача есть.
    {
      re: /FROM tasks t[\s\S]*FOR UPDATE OF t/,
      reply: (hits) =>
        hits === 1
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ id: payload.taskId, status: 'CODING', project_code: 'PS', service_code: 'Catalog_Service', reviewer_role_id: 'rev' }] },
    },
    { re: /SELECT id FROM projects WHERE code/, reply: { rowCount: 1, rows: [{ id: 'proj-1' }] } },
    { re: /SELECT id FROM services WHERE project_id/, reply: { rowCount: 1, rows: [{ id: 'svc-1' }] } },
    { re: /SELECT id FROM roles WHERE code = 'PROGRAMMER'/, reply: { rowCount: 1, rows: [{ id: 'role-prog' }] } },
    { re: /INSERT INTO tasks/, reply: { rowCount: 1, rows: [{ id: payload.taskId }] } },
    { re: /INSERT INTO task_events/, reply: { rowCount: 1, rows: [] } },
  ]);
  const { task, created } = await findOrCreateScannerTask(c, payload);
  assert.equal(created, true);
  assert.equal(task.id, payload.taskId);
  // Создана задача в CODING и записано событие TASK_CREATED.
  const ins = c.calls.find((q) => /INSERT INTO tasks/.test(q.sql));
  assert.ok(ins, 'должен быть INSERT INTO tasks');
  assert.deepEqual(ins.params.slice(0, 1), [payload.taskId]); // явный id из completion
  assert.ok(c.calls.some((q) => /INSERT INTO task_events/.test(q.sql) && q.params?.[2]?.includes?.('autoCreated')));
});

test('findOrCreateScannerTask: отсутствующий проект и сервис создаются', async () => {
  const c = fakeClient([
    {
      re: /FROM tasks t[\s\S]*FOR UPDATE OF t/,
      reply: (hits) =>
        hits === 1
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ id: payload.taskId, status: 'CODING', project_code: 'PS', service_code: 'Catalog_Service', reviewer_role_id: 'rev' }] },
    },
    { re: /SELECT id FROM projects WHERE code/, reply: { rowCount: 0, rows: [] } },
    { re: /INSERT INTO projects/, reply: { rowCount: 1, rows: [{ id: 'proj-new' }] } },
    { re: /SELECT id FROM services WHERE project_id/, reply: { rowCount: 0, rows: [] } },
    { re: /INSERT INTO services/, reply: { rowCount: 1, rows: [{ id: 'svc-new' }] } },
    { re: /SELECT id FROM roles WHERE code = 'PROGRAMMER'/, reply: { rowCount: 1, rows: [{ id: 'role-prog' }] } },
    { re: /INSERT INTO tasks/, reply: { rowCount: 1, rows: [{ id: payload.taskId }] } },
    { re: /INSERT INTO task_events/, reply: { rowCount: 1, rows: [] } },
  ]);
  const { created } = await findOrCreateScannerTask(c, payload);
  assert.equal(created, true);
  assert.ok(c.calls.some((q) => /INSERT INTO projects/.test(q.sql)), 'создан проект');
  assert.ok(c.calls.some((q) => /INSERT INTO services/.test(q.sql)), 'создан сервис');
});

test('findOrCreateScannerTask: пустой сервис → задача без сервиса (service_id null)', async () => {
  const c = fakeClient([
    {
      re: /FROM tasks t[\s\S]*FOR UPDATE OF t/,
      reply: (hits) =>
        hits === 1
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ id: payload.taskId, status: 'CODING', project_code: 'PS', service_code: null, reviewer_role_id: 'rev' }] },
    },
    { re: /SELECT id FROM projects WHERE code/, reply: { rowCount: 1, rows: [{ id: 'proj-1' }] } },
    { re: /SELECT id FROM roles WHERE code = 'PROGRAMMER'/, reply: { rowCount: 1, rows: [{ id: 'role-prog' }] } },
    { re: /INSERT INTO tasks/, reply: { rowCount: 1, rows: [{ id: payload.taskId }] } },
    { re: /INSERT INTO task_events/, reply: { rowCount: 1, rows: [] } },
  ]);
  const { created } = await findOrCreateScannerTask(c, { ...payload, service: '' });
  assert.equal(created, true);
  const ins = c.calls.find((q) => /INSERT INTO tasks/.test(q.sql));
  assert.equal(ins.params[2], null, 'service_id должен быть null');
  assert.equal(c.calls.some((q) => /INSERT INTO services/.test(q.sql)), false);
});

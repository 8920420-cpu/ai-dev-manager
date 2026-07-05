// FORK-BRANCH-CONTEXT-001 — контекст host-задачи для fork-ветви: changedFiles/result
// сдачи программиста ищутся по цепочке предков (у ребёнка ветки своих событий сдачи
// нет), корень цепочки даёт заголовок/описание коммита Git Integrator.
// Мини-клиент pg (как в reapOrphanRuns.test.js): отвечает по первому regex-правилу.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHostTaskContext } from '../src/db.js';

function fakeClient(rules = []) {
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

const CHAIN_RE = /WITH RECURSIVE chain AS/;
const EVENTS_RE = /FROM task_events[\s\S]*ANY\(\$1::uuid\[\]\)/;

test('fork-ветвь: changedFiles берутся из события РОДИТЕЛЯ, корень цепочки возвращается', async () => {
  const completion = { changedFiles: ['src/a.js', 'src/b.js'], result: 'готово' };
  const c = fakeClient([
    {
      re: CHAIN_RE,
      reply: {
        rowCount: 2,
        rows: [
          { id: 'child-1', title: 'Задача [Git Integrator]', description: 'desc', depth: 0 },
          { id: 'root-1', title: 'Короткий заголовок', description: 'Структурированное описание', depth: 1 },
        ],
      },
    },
    { re: EVENTS_RE, reply: { rowCount: 1, rows: [{ payload_json: completion }] } },
  ]);

  const ctx = await resolveHostTaskContext(c, 'child-1');

  assert.deepEqual(ctx.chainIds, ['child-1', 'root-1'], 'цепочка предков собрана');
  assert.equal(ctx.rootTask.id, 'root-1', 'корень цепочки — родитель');
  assert.equal(ctx.rootTask.title, 'Короткий заголовок');
  assert.deepEqual(ctx.scan.payload_json.changedFiles, ['src/a.js', 'src/b.js']);

  // События ищутся по ВСЕЙ цепочке, а не только по самой задаче.
  const evCall = c.calls.find((q) => EVENTS_RE.test(q.sql));
  assert.ok(evCall, 'запрос событий вызван');
  assert.deepEqual(evCall.params[0], ['child-1', 'root-1'], 'в запрос событий переданы все id цепочки');
});

test('фильтр событий: пустые changedFiles:[] и result:"" не считаются сдачей (отсеяны в SQL)', async () => {
  const c = fakeClient([
    { re: CHAIN_RE, reply: { rowCount: 1, rows: [{ id: 't1', title: 'x', description: '', depth: 0 }] } },
    { re: EVENTS_RE, reply: { rowCount: 0, rows: [] } },
  ]);

  const ctx = await resolveHostTaskContext(c, 't1');

  assert.equal(ctx.scan, null, 'без реальной сдачи scan пуст');
  const evCall = c.calls.find((q) => EVENTS_RE.test(q.sql));
  // Guard от регресса: непустота проверяется в SQL (раньше changedFiles:[] из
  // TASK_CREATED был truthy в JS и перекрывал реальную сдачу).
  assert.ok(/jsonb_typeof\(payload_json->'changedFiles'\) = 'array'/.test(evCall.sql), 'проверка типа массива');
  assert.ok(/jsonb_array_length\(payload_json->'changedFiles'\) > 0/.test(evCall.sql), 'массив должен быть непустым');
  assert.ok(/COALESCE\(payload_json->>'result', ''\) <> ''/.test(evCall.sql), 'result должен быть непустым');
});

// STALE-COMPLETION-ROLE-GUARD-001: поздний дубль сдачи с changedFiles:[] (но
// непустым result) идёт первым в порядке created_at DESC. Пустой список НЕ должен
// перекрывать реальные файлы из более ранней валидной сдачи — иначе Git Integrator
// получит no_changed_files и не закоммитит код (инцидент f43a9f6c).
test('поздний пустой changedFiles НЕ затирает список из более ранней валидной сдачи', async () => {
  const c = fakeClient([
    {
      re: CHAIN_RE,
      reply: { rowCount: 2, rows: [
        { id: 'child-1', title: 'T [ветка]', description: 'd', depth: 0 },
        { id: 'root-1', title: 'Корень', description: 'D', depth: 1 },
      ] },
    },
    {
      re: EVENTS_RE,
      // created_at DESC: поздний дубль (пустой changedFiles, непустой result) первым,
      // реальная сдача с 5 файлами — следом.
      reply: { rowCount: 2, rows: [
        { payload_json: { changedFiles: [], result: 'поздний дубль (28 ходов)' } },
        { payload_json: { changedFiles: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'], result: 'сдача' } },
      ] },
    },
  ]);

  const ctx = await resolveHostTaskContext(c, 'child-1');

  assert.deepEqual(
    ctx.scan.payload_json.changedFiles,
    ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'],
    'пустой список поздней сдачи не перекрыл реальные 5 файлов',
  );
});

// changedFiles агрегируются по всей цепочке событий сдачи с дедупом (объединение).
test('changedFiles агрегируются по цепочке предков с дедупом', async () => {
  const c = fakeClient([
    {
      re: CHAIN_RE,
      reply: { rowCount: 2, rows: [
        { id: 'child-1', title: 't', description: '', depth: 0 },
        { id: 'root-1', title: 'r', description: '', depth: 1 },
      ] },
    },
    {
      re: EVENTS_RE,
      reply: { rowCount: 2, rows: [
        { payload_json: { changedFiles: ['a.js', 'b.js'], result: 'v2' } },
        { payload_json: { changedFiles: ['b.js', 'c.js'], result: 'v1' } },
      ] },
    },
  ]);

  const ctx = await resolveHostTaskContext(c, 'child-1');

  assert.deepEqual(ctx.scan.payload_json.changedFiles, ['a.js', 'b.js', 'c.js'], 'объединение с дедупом (b.js один раз)');
  assert.equal(ctx.scan.payload_json.result, 'v2', 'result — из последней сдачи с непустым результатом');
});

test('без предков: цепочка из самой задачи, rootTask = сама задача', async () => {
  const c = fakeClient([
    { re: CHAIN_RE, reply: { rowCount: 1, rows: [{ id: 't1', title: 'Заголовок', description: 'd', depth: 0 }] } },
    { re: EVENTS_RE, reply: { rowCount: 1, rows: [{ payload_json: { changedFiles: ['f.js'], result: 'ok' } }] } },
  ]);

  const ctx = await resolveHostTaskContext(c, 't1');

  assert.deepEqual(ctx.chainIds, ['t1']);
  assert.equal(ctx.rootTask.id, 't1', 'корень — сама задача');
  assert.deepEqual(ctx.scan.payload_json.changedFiles, ['f.js']);
});

// WORKTREE-BRANCH-CONTEXT-001: сдача через worktree несёт ветку/коммит программиста;
// они пробрасываются в контекст (Git Integrator вливает ветку в main, а не ищет
// незакоммиченные файлы в основном дереве).
test('сдача с worktreeBranch/deliveredCommit → они попадают в scan.payload_json', async () => {
  const c = fakeClient([
    { re: CHAIN_RE, reply: { rowCount: 1, rows: [{ id: 't1', title: 'T', description: 'd', depth: 0 }] } },
    {
      re: EVENTS_RE,
      reply: { rowCount: 1, rows: [{ payload_json: {
        changedFiles: ['src/widget.js'], result: 'сдача',
        worktreeBranch: 'programmer/PROJECT_2/orchestrator-service', deliveredCommit: 'd42902dd',
      } }] },
    },
  ]);

  const ctx = await resolveHostTaskContext(c, 't1');

  assert.equal(ctx.scan.payload_json.worktreeBranch, 'programmer/PROJECT_2/orchestrator-service');
  assert.equal(ctx.scan.payload_json.deliveredCommit, 'd42902dd');
});

// created_at DESC: последняя непустая ветка/коммит выигрывают, но пустой поздний
// дубль не затирает реальную ветку из более ранней валидной сдачи.
test('последняя непустая ветка/коммит выигрывают; пустой дубль не затирает', async () => {
  const c = fakeClient([
    { re: CHAIN_RE, reply: { rowCount: 1, rows: [{ id: 't1', title: 'T', description: 'd', depth: 0 }] } },
    {
      re: EVENTS_RE,
      reply: { rowCount: 2, rows: [
        { payload_json: { changedFiles: [], result: 'поздний дубль', worktreeBranch: '', deliveredCommit: '' } },
        { payload_json: { changedFiles: ['a.js'], result: 'сдача', worktreeBranch: 'programmer/PS/svc', deliveredCommit: 'abc123' } },
      ] },
    },
  ]);

  const ctx = await resolveHostTaskContext(c, 't1');

  assert.equal(ctx.scan.payload_json.worktreeBranch, 'programmer/PS/svc', 'пустой дубль не перекрыл ветку');
  assert.equal(ctx.scan.payload_json.deliveredCommit, 'abc123');
});

// Обратная совместимость: сдача без worktree-полей (старый раннер) → они null,
// прежнее поведение сохраняется.
test('сдача без worktreeBranch/deliveredCommit → поля пустые (null)', async () => {
  const c = fakeClient([
    { re: CHAIN_RE, reply: { rowCount: 1, rows: [{ id: 't1', title: 'T', description: 'd', depth: 0 }] } },
    { re: EVENTS_RE, reply: { rowCount: 1, rows: [{ payload_json: { changedFiles: ['f.js'], result: 'ok' } }] } },
  ]);

  const ctx = await resolveHostTaskContext(c, 't1');

  assert.equal(ctx.scan.payload_json.worktreeBranch, null, 'нет worktree-ветки → null');
  assert.equal(ctx.scan.payload_json.deliveredCommit, null, 'нет коммита → null');
  assert.deepEqual(ctx.scan.payload_json.changedFiles, ['f.js'], 'прежнее поведение по changedFiles');
});

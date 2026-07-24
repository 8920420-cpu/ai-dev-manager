import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWorkItems,
  computePlannedServices,
  materializeDecomposition,
  advanceDecompositionParents,
  acceptScannerCompletionTx,
  normalizeScannerCompletion,
  normalizePathKey,
  computePathIntersectionDeps,
  pathIntersectionBarrierEnabled,
} from '../src/db.js';

// Мини-клиент pg (как в forkJoin.test.js): отвечает по первому regex-правилу.
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

// --- normalizeWorkItems (чистая функция) ------------------------------------

test('normalizeWorkItems: берёт work_items как есть, чистит пустые файлы', () => {
  const card = {
    work_items: [
      { serviceCode: 'SvcA', title: 'A', files: [{ path: 'a.js', what: 'x' }, { path: '', what: 'нет пути' }] },
      { serviceCode: '', files: [] }, // без сервиса — отбрасывается
    ],
  };
  const out = normalizeWorkItems(card);
  assert.equal(out.length, 1);
  assert.equal(out[0].serviceCode, 'SvcA');
  assert.equal(out[0].files.length, 1, 'файл без path отброшен');
});

test('normalizeWorkItems: фолбэк из affected_files с группировкой по сервису', () => {
  const card = {
    affected_files: [
      { serviceCode: 'SvcA', path: 'a.js', what: 'x' },
      { serviceCode: 'SvcA', path: 'b.js', what: 'y' },
      { serviceCode: 'SvcB', path: 'c.js', what: 'z' },
    ],
  };
  const out = normalizeWorkItems(card);
  assert.equal(out.length, 2, 'два сервиса');
  const a = out.find((i) => i.serviceCode === 'SvcA');
  assert.equal(a.files.length, 2);
});

// json-поля контракта модель возвращает СТРОКОЙ («JSON serialized as a string»,
// fieldJsonSchema) — normalizeWorkItems обязан их парсить, иначе Архитектор
// блокируется architect_no_service:empty при валидном вердикте.
test('normalizeWorkItems: work_items JSON-строкой парсится как массив', () => {
  const card = {
    work_items: JSON.stringify([
      { serviceCode: 'SvcA', title: 'A', files: [{ path: 'a.js', what: 'x' }] },
    ]),
  };
  const out = normalizeWorkItems(card);
  assert.equal(out.length, 1);
  assert.equal(out[0].serviceCode, 'SvcA');
  assert.equal(out[0].files.length, 1);
});

test('normalizeWorkItems: фолбэк affected_files JSON-строкой', () => {
  const card = {
    affected_files: JSON.stringify([{ serviceCode: 'SvcB', path: 'c.js', what: 'z' }]),
  };
  const out = normalizeWorkItems(card);
  assert.equal(out.length, 1);
  assert.equal(out[0].serviceCode, 'SvcB');
});

test('normalizeWorkItems: битая JSON-строка или не-массив — пустой план, без исключений', () => {
  assert.equal(normalizeWorkItems({ work_items: '[{oops' }).length, 0);
  assert.equal(normalizeWorkItems({ work_items: '{"serviceCode":"SvcA"}' }).length, 0);
  assert.equal(normalizeWorkItems({ affected_files: 'просто текст' }).length, 0);
});

// --- PATH-INTERSECTION-BARRIER-001 (чистые функции) -------------------------

test('normalizePathKey: слэши/регистр/пробелы/ведущее ./ и хвостовой /', () => {
  assert.equal(normalizePathKey('.\\Packages\\Platform\\Log.TS'), 'packages/platform/log.ts');
  assert.equal(normalizePathKey('  ./src/x/  '), 'src/x');
  assert.equal(normalizePathKey(''), '');
  assert.equal(normalizePathKey(null), '');
});

test('computePathIntersectionDeps: один общий файл в двух сервисах → одно ребро (потребитель зависит от первого)', () => {
  const edges = computePathIntersectionDeps([
    { id: 'a', path: 'packages/platform/log.ts' },
    { id: 'b', path: 'svcA/only.ts' },
    { id: 'c', path: 'packages/platform/log.ts' },
  ]);
  assert.deepEqual(edges, [{ taskId: 'c', dependsOn: 'a' }]);
});

test('computePathIntersectionDeps: три правки одного файла → цепочка (2 ребра), а не звезда', () => {
  const edges = computePathIntersectionDeps([
    { id: 'a', path: 'p/x.ts' }, { id: 'b', path: 'p/x.ts' }, { id: 'c', path: 'p/x.ts' },
  ]);
  assert.deepEqual(edges, [
    { taskId: 'b', dependsOn: 'a' },
    { taskId: 'c', dependsOn: 'b' },
  ]);
});

test('computePathIntersectionDeps: контрактные и пустые пути не сериализуются', () => {
  assert.deepEqual(computePathIntersectionDeps([
    { id: 'a', path: 'proto-contracts/chat/chat.proto' },
    { id: 'b', path: 'proto-contracts/chat/chat.proto' },
  ]), [], 'контракт держит proto-барьер, не path-барьер');
  assert.deepEqual(computePathIntersectionDeps([
    { id: 'a', path: '' }, { id: 'b', path: '' },
  ]), [], 'пустые пути (подзадача-на-весь-сервис) — нет файловой гонки');
});

test('computePathIntersectionDeps: разные файлы → нет рёбер; нормализация ловит один файл в разной записи', () => {
  assert.deepEqual(computePathIntersectionDeps([
    { id: 'a', path: 'x.ts' }, { id: 'b', path: 'y.ts' },
  ]), []);
  assert.deepEqual(computePathIntersectionDeps([
    { id: 'a', path: 'Pkg\\Util.ts' }, { id: 'b', path: 'pkg/util.ts' },
  ]), [{ taskId: 'b', dependsOn: 'a' }]);
});

test('pathIntersectionBarrierEnabled: по умолчанию выключено, включается 1/true/on', () => {
  const prev = process.env.PROGRAMMER_PATH_BARRIER;
  try {
    delete process.env.PROGRAMMER_PATH_BARRIER;
    assert.equal(pathIntersectionBarrierEnabled(), false);
    process.env.PROGRAMMER_PATH_BARRIER = '1';
    assert.equal(pathIntersectionBarrierEnabled(), true);
    process.env.PROGRAMMER_PATH_BARRIER = 'on';
    assert.equal(pathIntersectionBarrierEnabled(), true);
    process.env.PROGRAMMER_PATH_BARRIER = '0';
    assert.equal(pathIntersectionBarrierEnabled(), false);
    process.env.PROGRAMMER_PATH_BARRIER = 'off';
    assert.equal(pathIntersectionBarrierEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.PROGRAMMER_PATH_BARRIER;
    else process.env.PROGRAMMER_PATH_BARRIER = prev;
  }
});

// --- materializeDecomposition -----------------------------------------------

function decomposerClaimed() {
  return {
    id: 'epic1', project_id: 'p1', description: 'd', data_card: {},
    role_code: 'DECOMPOSER', role_id: 'rD', agentRunId: 'run1', status: 'DECOMPOSITION',
    current_stage_key: null,
  };
}

test('materializeDecomposition: 2 сервиса → 2 задачи-на-сервис + 3 подзадачи, эпик паркуется', async () => {
  const c = fakeClient([
    { re: /FROM tasks WHERE parent_task_id = \$1 LIMIT 1/, reply: { rowCount: 0, rows: [] } },
    { re: /FROM services WHERE project_id/, reply: { rowCount: 2, rows: [
      { id: 'sidA', service_code: 'SvcA' }, { id: 'sidB', service_code: 'SvcB' },
    ] } },
    { re: /FROM roles WHERE code = 'PROGRAMMER'/, reply: { rowCount: 1, rows: [{ id: 'rProg' }] } },
    { re: /INSERT INTO tasks[\s\S]*'service'[\s\S]*RETURNING id/, reply: (h) => ({ rowCount: 1, rows: [{ id: `l1-${h}` }] }) },
    { re: /INSERT INTO tasks[\s\S]*'subtask'[\s\S]*RETURNING id/, reply: (h) => ({ rowCount: 1, rows: [{ id: `sub-${h}` }] }) },
  ]);

  const verdict = { status: 'READY', summary: 's', findings: [], ok: true };
  // work_items с кодами в нижнем регистре — проверяем регистронезависимый резолв.
  const cardValues = { work_items: [
    { serviceCode: 'svca', title: 'A', files: [{ path: 'a.js', what: 'x' }, { path: 'b.js', what: 'y' }] },
    { serviceCode: 'svcb', title: 'B', files: [{ path: 'c.js', what: 'z' }] },
  ] };

  const res = await materializeDecomposition(c, decomposerClaimed(), {
    verdict, response: '', exchangeId: null, durationMs: 1, decision: { outcome: 'FORWARD' }, cardValues, route: [],
  });

  assert.equal(res.toStatus, 'WAITING_FOR_CHILDREN');
  assert.equal(res.services, 2);
  assert.equal(res.subtasks, 3);

  const svcInserts = c.calls.filter((q) => /INSERT INTO tasks[\s\S]*'service'[\s\S]*RETURNING id/.test(q.sql));
  assert.equal(svcInserts.length, 2, 'две задачи-на-сервис');
  const subInserts = c.calls.filter((q) => /INSERT INTO tasks[\s\S]*'subtask'/.test(q.sql));
  assert.equal(subInserts.length, 3, 'три подзадачи-на-файл');
  const deps = c.calls.filter((q) => /INSERT INTO task_dependencies/.test(q.sql));
  assert.equal(deps.length, 2, 'зависимости эпик→сервис');
  assert.ok(c.calls.some((q) => /UPDATE tasks SET task_kind = 'epic'/.test(q.sql)), 'эпик помечен и припаркован');
  assert.ok(c.calls.some((q) => /UPDATE agent_runs SET status = 'SUCCESS'/.test(q.sql)), 'прогон декомпозитора успешен');
});

// PROGRAMMER-CONTRACT-BARRIER-001: владелец общего контракта (proto) → потребители
// зависят от его L1 (task_dependencies), в data_card эпика — маркер contract_barrier.
test('materializeDecomposition: владелец proto → потребители зависят от его L1 + contract_barrier', async () => {
  const c = fakeClient([
    { re: /FROM tasks WHERE parent_task_id = \$1 LIMIT 1/, reply: { rowCount: 0, rows: [] } },
    { re: /FROM services WHERE project_id/, reply: { rowCount: 3, rows: [
      { id: 'sidChat', service_code: 'Chat_Service' },
      { id: 'sidGw', service_code: 'Getway' },
      { id: 'sidFe', service_code: 'Chat_Frontend' },
    ] } },
    { re: /FROM roles WHERE code = 'PROGRAMMER'/, reply: { rowCount: 1, rows: [{ id: 'rProg' }] } },
    { re: /INSERT INTO tasks[\s\S]*'service'[\s\S]*RETURNING id/, reply: (h) => ({ rowCount: 1, rows: [{ id: `l1-${h}` }] }) },
    { re: /INSERT INTO tasks[\s\S]*'subtask'[\s\S]*RETURNING id/, reply: (h) => ({ rowCount: 1, rows: [{ id: `sub-${h}` }] }) },
  ]);
  const verdict = { status: 'READY', summary: 's', findings: [], ok: true };
  const cardValues = { work_items: [
    { serviceCode: 'Chat_Service', title: 'proto', files: [{ path: 'proto-contracts/chat/chat.proto', what: 'partner fields' }] },
    { serviceCode: 'Getway', title: 'passthrough', files: [{ path: 'internal/handlers/http/inbox.go', what: 'pass partner' }] },
    { serviceCode: 'Chat_Frontend', title: 'ui', files: [{ path: 'src/ClientCard.tsx', what: 'show partner' }] },
  ] };
  await materializeDecomposition(c, decomposerClaimed(), {
    verdict, response: '', exchangeId: null, durationMs: 1, decision: { outcome: 'FORWARD' }, cardValues, route: [],
  });
  // Владелец контракта — Chat_Service (l1-1). Барьер-зависимости: подзадачи
  // потребителей (sub-2 Getway, sub-3 Frontend) → l1-1. Подзадача владельца (sub-1) — нет.
  const barrierDeps = c.calls.filter((q) => /INSERT INTO task_dependencies/.test(q.sql)
    && q.params[1] === 'l1-1' && String(q.params[0]).startsWith('sub-'));
  assert.deepEqual(barrierDeps.map((q) => q.params[0]).sort(), ['sub-2', 'sub-3'],
    'оба потребителя зависят от L1 владельца контракта, владелец — нет');
  const upd = c.calls.find((q) => /UPDATE tasks SET task_kind = 'epic'/.test(q.sql));
  const cb = JSON.parse(upd.params[1]).contract_barrier;
  assert.ok(cb, 'contract_barrier зафиксирован в data_card эпика');
  assert.equal(cb.ownerService, 'Chat_Service');
  assert.equal(cb.ownerTaskId, 'l1-1');
  assert.equal(cb.deps, 2);
});

// PATH-INTERSECTION-BARRIER-001: общий не-контрактный файл в двух сервисах →
// подзадача-потребитель зависит от первой правки этого файла (сериализация).
function sharedFileClient() {
  return fakeClient([
    { re: /FROM tasks WHERE parent_task_id = \$1 LIMIT 1/, reply: { rowCount: 0, rows: [] } },
    { re: /FROM services WHERE project_id/, reply: { rowCount: 2, rows: [
      { id: 'sidA', service_code: 'SvcA' }, { id: 'sidB', service_code: 'SvcB' },
    ] } },
    { re: /FROM roles WHERE code = 'PROGRAMMER'/, reply: { rowCount: 1, rows: [{ id: 'rProg' }] } },
    { re: /INSERT INTO tasks[\s\S]*'service'[\s\S]*RETURNING id/, reply: (h) => ({ rowCount: 1, rows: [{ id: `l1-${h}` }] }) },
    { re: /INSERT INTO tasks[\s\S]*'subtask'[\s\S]*RETURNING id/, reply: (h) => ({ rowCount: 1, rows: [{ id: `sub-${h}` }] }) },
  ]);
}
// Оба сервиса правят один и тот же общий файл packages/platform/log.ts.
// Порядок подзадач: sub-1=SvcA/log.ts, sub-2=SvcA/a.ts, sub-3=SvcB/b.ts, sub-4=SvcB/log.ts.
const SHARED_FILE_CARD = { work_items: [
  { serviceCode: 'SvcA', title: 'A', files: [{ path: 'packages/platform/log.ts', what: 'shared' }, { path: 'svcA/a.ts', what: 'own' }] },
  { serviceCode: 'SvcB', title: 'B', files: [{ path: 'svcB/b.ts', what: 'own' }, { path: 'packages/platform/log.ts', what: 'shared' }] },
] };

test('materializeDecomposition (клапан вкл): общий файл двух сервисов → потребитель зависит от первого + path_barrier', async () => {
  const prev = process.env.PROGRAMMER_PATH_BARRIER;
  process.env.PROGRAMMER_PATH_BARRIER = '1';
  try {
    const c = sharedFileClient();
    const verdict = { status: 'READY', summary: 's', findings: [], ok: true };
    await materializeDecomposition(c, decomposerClaimed(), {
      verdict, response: '', exchangeId: null, durationMs: 1, decision: { outcome: 'FORWARD' },
      cardValues: SHARED_FILE_CARD, route: [],
    });
    const pathDep = c.calls.filter((q) => /INSERT INTO task_dependencies/.test(q.sql)
      && q.params[0] === 'sub-4' && q.params[1] === 'sub-1');
    assert.equal(pathDep.length, 1, 'подзадача-потребитель общего файла (sub-4) зависит от первой правки (sub-1)');
    const upd = c.calls.find((q) => /UPDATE tasks SET task_kind = 'epic'/.test(q.sql));
    const pb = JSON.parse(upd.params[1]).path_barrier;
    assert.ok(pb, 'path_barrier зафиксирован в data_card эпика');
    assert.equal(pb.sharedPathDeps, 1);
  } finally {
    if (prev === undefined) delete process.env.PROGRAMMER_PATH_BARRIER;
    else process.env.PROGRAMMER_PATH_BARRIER = prev;
  }
});

test('materializeDecomposition (клапан выкл, дефолт): общий файл НЕ сериализуется, path_barrier отсутствует', async () => {
  const prev = process.env.PROGRAMMER_PATH_BARRIER;
  delete process.env.PROGRAMMER_PATH_BARRIER;
  try {
    const c = sharedFileClient();
    const verdict = { status: 'READY', summary: 's', findings: [], ok: true };
    await materializeDecomposition(c, decomposerClaimed(), {
      verdict, response: '', exchangeId: null, durationMs: 1, decision: { outcome: 'FORWARD' },
      cardValues: SHARED_FILE_CARD, route: [],
    });
    const pathDep = c.calls.filter((q) => /INSERT INTO task_dependencies/.test(q.sql)
      && q.params[0] === 'sub-4' && q.params[1] === 'sub-1');
    assert.equal(pathDep.length, 0, 'без клапана общий файл не сериализуется');
    const upd = c.calls.find((q) => /UPDATE tasks SET task_kind = 'epic'/.test(q.sql));
    assert.equal(JSON.parse(upd.params[1]).path_barrier, undefined);
  } finally {
    if (prev === undefined) delete process.env.PROGRAMMER_PATH_BARRIER;
    else process.env.PROGRAMMER_PATH_BARRIER = prev;
  }
});

test('materializeDecomposition: ни одного зарегистрированного сервиса → эпик BLOCKED', async () => {
  const c = fakeClient([
    { re: /FROM tasks WHERE parent_task_id = \$1 LIMIT 1/, reply: { rowCount: 0, rows: [] } },
    { re: /FROM services WHERE project_id/, reply: { rowCount: 0, rows: [] } },
  ]);
  const verdict = { status: 'READY', summary: 's', findings: [], ok: true };
  const cardValues = { work_items: [{ serviceCode: 'Unknown', files: [{ path: 'x.js', what: 'y' }] }] };

  const res = await materializeDecomposition(c, decomposerClaimed(), {
    verdict, response: '', exchangeId: null, durationMs: 1, decision: { outcome: 'FORWARD' }, cardValues, route: [],
  });

  assert.equal(res.toStatus, 'BLOCKED');
  assert.equal(res.reason, 'decomposition_no_services');
  assert.ok(c.calls.some((q) => /UPDATE tasks SET status = 'BLOCKED'/.test(q.sql)));
  assert.ok(c.calls.some((q) => /UPDATE agent_runs SET status = 'FAILED'/.test(q.sql)));
  assert.equal(c.calls.some((q) => /INSERT INTO tasks/.test(q.sql)), false, 'детей не создаём');
});

test('materializeDecomposition: эпик уже расщеплён → идемпотентно, без дублей', async () => {
  const c = fakeClient([
    { re: /FROM tasks WHERE parent_task_id = \$1 LIMIT 1/, reply: { rowCount: 1, rows: [{ '?column?': 1 }] } },
  ]);
  const verdict = { status: 'READY', summary: 's', findings: [], ok: true };
  const res = await materializeDecomposition(c, decomposerClaimed(), {
    verdict, response: '', exchangeId: null, durationMs: 1, decision: { outcome: 'FORWARD' },
    cardValues: { work_items: [] }, route: [],
  });
  assert.equal(res.reason, 'already_decomposed');
  assert.equal(c.calls.some((q) => /INSERT INTO tasks/.test(q.sql)), false);
});

// --- advanceDecompositionParents (роллап эпиков) ----------------------------

test('advanceDecompositionParents: все сервисы DONE → эпик DONE', async () => {
  const c = fakeClient([
    { re: /FROM tasks t\s+WHERE t.task_kind = 'epic'/, reply: { rowCount: 1, rows: [
      { id: 'epic1', status: 'WAITING_FOR_CHILDREN', current_role_id: 'rD' },
    ] } },
    { re: /task_kind IN \('service','epic'\) AND status IN \('BLOCKED','FAILED'\)/, reply: { rowCount: 1, rows: [{ n: 0 }] } },
  ]);
  const n = await advanceDecompositionParents(c);
  assert.equal(n, 1);
  const upd = c.calls.find((q) => /UPDATE tasks SET status = \$2::task_status/.test(q.sql));
  assert.equal(upd.params[1], 'DONE');
  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  assert.equal(ev.params[1], 'TASK_DONE', 'событие завершения эпика');
});

test('advanceDecompositionParents: упавший сервис → эпик BLOCKED', async () => {
  const c = fakeClient([
    { re: /FROM tasks t\s+WHERE t.task_kind = 'epic'/, reply: { rowCount: 1, rows: [
      { id: 'epic1', status: 'WAITING_FOR_CHILDREN', current_role_id: 'rD' },
    ] } },
    { re: /task_kind IN \('service','epic'\) AND status IN \('BLOCKED','FAILED'\)/, reply: { rowCount: 1, rows: [{ n: 1 }] } },
  ]);
  const n = await advanceDecompositionParents(c);
  assert.equal(n, 1);
  const upd = c.calls.find((q) => /UPDATE tasks SET status = \$2::task_status/.test(q.sql));
  assert.equal(upd.params[1], 'BLOCKED');
});

// --- computePlannedServices (чистая функция) --------------------------------

test('computePlannedServices: affected_services ∪ work_items, канонические коды, дедуп', () => {
  const canonicalByCode = new Map([
    ['svca', 'SvcA'], ['svcb', 'SvcB'], ['svcc', 'SvcC'],
  ]);
  const card = {
    // work_items урезаны до SvcA/SvcB, но affected_services несёт полный scope (SvcC).
    affected_services: [{ serviceCode: 'SvcA', reason: 'x' }, { serviceCode: 'svcc', reason: 'y' }],
    work_items: [
      { serviceCode: 'SvcA', title: 'A', files: [{ path: 'a.js', what: 'x' }] },
      { serviceCode: 'SvcB', title: 'B', files: [{ path: 'c.js', what: 'z' }] },
    ],
  };
  const planned = computePlannedServices(card, canonicalByCode);
  assert.deepEqual([...planned].sort(), ['SvcA', 'SvcB', 'SvcC'], 'union каноническими кодами без дублей');
});

test('computePlannedServices: незарегистрированные коды отбрасываются', () => {
  const canonicalByCode = new Map([['svca', 'SvcA']]);
  const card = { affected_services: [{ serviceCode: 'SvcA' }, { serviceCode: 'Ghost' }] };
  assert.deepEqual(computePlannedServices(card, canonicalByCode), ['SvcA']);
});

// --- materializeDecomposition: фиксация planned_services --------------------

test('materializeDecomposition: пишет planned_services из affected_services ∪ work_items', async () => {
  const c = fakeClient([
    { re: /FROM tasks WHERE parent_task_id = \$1 LIMIT 1/, reply: { rowCount: 0, rows: [] } },
    { re: /FROM services WHERE project_id/, reply: { rowCount: 3, rows: [
      { id: 'sidA', service_code: 'SvcA' }, { id: 'sidB', service_code: 'SvcB' }, { id: 'sidC', service_code: 'SvcC' },
    ] } },
    { re: /FROM roles WHERE code = 'PROGRAMMER'/, reply: { rowCount: 1, rows: [{ id: 'rProg' }] } },
    { re: /INSERT INTO tasks[\s\S]*'service'[\s\S]*RETURNING id/, reply: (h) => ({ rowCount: 1, rows: [{ id: `l1-${h}` }] }) },
    { re: /INSERT INTO tasks[\s\S]*'subtask'[\s\S]*RETURNING id/, reply: (h) => ({ rowCount: 1, rows: [{ id: `sub-${h}` }] }) },
  ]);
  const verdict = { status: 'READY', summary: 's', findings: [], ok: true };
  // work_items только по SvcA/SvcB (SvcC «съеден» усечением) — affected_services несёт полный scope.
  const cardValues = {
    affected_services: [{ serviceCode: 'SvcA', reason: 'x' }, { serviceCode: 'svcc', reason: 'y' }],
    work_items: [
      { serviceCode: 'SvcA', title: 'A', files: [{ path: 'a.js', what: 'x' }] },
      { serviceCode: 'SvcB', title: 'B', files: [{ path: 'c.js', what: 'z' }] },
    ],
  };
  await materializeDecomposition(c, decomposerClaimed(), {
    verdict, response: '', exchangeId: null, durationMs: 1, decision: { outcome: 'FORWARD' }, cardValues, route: [],
  });
  const upd = c.calls.find((q) => /UPDATE tasks SET task_kind = 'epic'/.test(q.sql));
  assert.ok(upd, 'эпик припаркован');
  const planned = JSON.parse(upd.params[1]).planned_services;
  assert.deepEqual([...planned].sort(), ['SvcA', 'SvcB', 'SvcC'], 'целевой scope зафиксирован в data_card');
});

// --- advanceDecompositionParents: сверка с planned_services -----------------

test('advanceDecompositionParents: planned_services=4, покрыто 2 → эпик BLOCKED (B1), не DONE', async () => {
  const c = fakeClient([
    { re: /FROM tasks t\s+WHERE t.task_kind = 'epic'/, reply: { rowCount: 1, rows: [
      { id: 'epic1', status: 'WAITING_FOR_CHILDREN', current_role_id: 'rD',
        data_card: { planned_services: ['WEBSTORE', 'Smeta', 'IAM_Service', 'FastTable'] } },
    ] } },
    { re: /task_kind IN \('service','epic'\) AND status IN \('BLOCKED','FAILED'\)/, reply: { rowCount: 1, rows: [{ n: 0 }] } },
    { re: /FROM tasks ch JOIN services s ON s.id = ch.service_id/, reply: { rowCount: 2, rows: [
      { code: 'webstore' }, { code: 'iam_service' },
    ] } },
  ]);
  const n = await advanceDecompositionParents(c);
  assert.equal(n, 1);
  const upd = c.calls.find((q) => /UPDATE tasks SET status = \$2::task_status/.test(q.sql));
  assert.equal(upd.params[1], 'BLOCKED', 'эпик не DONE при потерянных сервисах');
  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  assert.equal(ev.params[1], 'TASK_BLOCKED', 'событие блокировки эпика');
  const payload = JSON.parse(ev.params[4]);
  assert.equal(payload.reason, 'epic_missing_services');
  assert.deepEqual([...payload.missingServices].sort(), ['FastTable', 'Smeta'], 'перечень недостающих сервисов');
});

test('advanceDecompositionParents: planned_services полностью покрыты → эпик DONE', async () => {
  const c = fakeClient([
    { re: /FROM tasks t\s+WHERE t.task_kind = 'epic'/, reply: { rowCount: 1, rows: [
      { id: 'epic1', status: 'WAITING_FOR_CHILDREN', current_role_id: 'rD',
        data_card: { planned_services: ['SvcA', 'SvcB'] } },
    ] } },
    { re: /task_kind IN \('service','epic'\) AND status IN \('BLOCKED','FAILED'\)/, reply: { rowCount: 1, rows: [{ n: 0 }] } },
    { re: /FROM tasks ch JOIN services s ON s.id = ch.service_id/, reply: { rowCount: 2, rows: [
      { code: 'svca' }, { code: 'svcb' },
    ] } },
  ]);
  const n = await advanceDecompositionParents(c);
  assert.equal(n, 1);
  const upd = c.calls.find((q) => /UPDATE tasks SET status = \$2::task_status/.test(q.sql));
  assert.equal(upd.params[1], 'DONE', 'весь scope покрыт → штатный DONE');
});

// --- acceptScannerCompletionTx: сдача подзадачи -----------------------------

function subtaskCompletionRules(openSubtasks) {
  return [
    { re: /FROM projects\s+WHERE code/, reply: { rowCount: 1, rows: [{ id: 'p1', code: 'PROJ' }] } },
    { re: /reviewer_role_id/, reply: { rowCount: 1, rows: [{
      id: '11111111-1111-4111-8111-111111111111', status: 'CODING', project_id: 'p1', project_code: 'PROJ',
      service_code: 'SvcA', reviewer_role_id: 'rRev', current_role_id: 'rProg', current_role_code: 'PROGRAMMER',
      task_kind: 'subtask', parent_task_id: 'L1',
    }] } },
    { re: /INSERT INTO scanner_dispatches/, reply: { rowCount: 1, rows: [{ id: 'disp1' }] } },
    { re: /to_regclass\('public\.role_fields'\)/, reply: { rowCount: 1, rows: [{ t: null }] } },
    { re: /count\(\*\)::int AS n FROM tasks\s+WHERE parent_task_id = \$1 AND task_kind = 'subtask'/,
      reply: { rowCount: 1, rows: [{ n: openSubtasks }] } },
    { re: /UPDATE tasks SET status = \$2::task_status, current_role_id = \$3, assigned_agent_id = NULL[\s\S]*WHERE id = \$1 AND status = 'WAITING_FOR_CHILDREN'/,
      reply: { rowCount: 1, rows: [{ status: 'WAITING_FOR_CHILDREN' }] } },
  ];
}

const SUBTASK_INPUT = {
  taskId: '11111111-1111-4111-8111-111111111111', completionKey: 'k1', project: 'PROJ', service: 'SvcA',
  title: 't', sourceDocument: 'doc', result: 'готово', changedFiles: ['a.js'],
};

test('acceptScannerCompletionTx: подзадача сдана, остались сёстры → родитель НЕ промоутится', async () => {
  const c = fakeClient(subtaskCompletionRules(2));
  const res = await acceptScannerCompletionTx(c, normalizeScannerCompletion(SUBTASK_INPUT));
  assert.equal(res.kind, 'subtask');
  assert.equal(res.parentPromoted, false);
  assert.equal(res.nextRole, null);
  assert.ok(c.calls.some((q) => /UPDATE tasks SET status = 'DONE'/.test(q.sql)), 'подзадача в DONE');
  assert.equal(
    c.calls.some((q) => /status = 'WAITING_FOR_CHILDREN'/.test(q.sql) && /UPDATE tasks/.test(q.sql)),
    false, 'родителя не трогаем',
  );
});

test('acceptScannerCompletionTx: последняя подзадача → родитель уходит в REVIEW/TASK_REVIEWER', async () => {
  const c = fakeClient(subtaskCompletionRules(0));
  const res = await acceptScannerCompletionTx(c, normalizeScannerCompletion(SUBTASK_INPUT));
  assert.equal(res.kind, 'subtask');
  assert.equal(res.parentPromoted, true);
  assert.equal(res.nextRole, 'TASK_REVIEWER');
  const promote = c.calls.find((q) => /WHERE id = \$1 AND status = 'WAITING_FOR_CHILDREN'/.test(q.sql));
  assert.ok(promote, 'родитель промоутится');
  assert.equal(promote.params[1], 'REVIEW', 'в статус REVIEW');
});

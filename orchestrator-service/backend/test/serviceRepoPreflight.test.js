import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preflightServiceRepoPath, applyReasoningVerdict } from '../src/db.js';
import { buildRoute } from '../src/projectRoute.js';

// SERVICE-REPO-PATH-PREFLIGHT-001 — ранний preflight repository_path сервиса на
// финализации Архитектора: сервис без пути/с несуществующим каталогом → провал с
// кодом missing_repository_path ДО этапа Programmer/Pipeline; валидный путь → ok.

// Мини-клиент pg (как в serviceRepoPath.test.js): отвечает по первому правилу.
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

function makeTree(dirs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svcpreflight-'));
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

// Клиент, отдающий одну строку сервиса на JOIN services↔projects.
function svcClient({ service_code, repository_path, root_path }) {
  return fakeClient([
    { re: /FROM services s JOIN projects p/, reply: {
      rowCount: 1, rows: [{ service_code, repository_path, root_path }],
    } },
  ]);
}

// --- Ветка «нет repository_path» → BLOCKED-диагноз missing_repository_path --------

test('preflight: пустой repository_path (корень не виден процессу) → missing_repository_path', async () => {
  // Корень — путь ХОСТА, процессу не виден (как оркестратор в контейнере): пустой
  // путь бэкфиллить нечем → провал (CONTAINER-FS-DEGRADE-001).
  const c = svcClient({ service_code: 'CHAT', repository_path: null, root_path: 'K:\\no\\such\\host\\root' });
  const r = await preflightServiceRepoPath(c, 'svc-1');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'missing_repository_path');
  assert.match(r.reason, /^missing_repository_path:CHAT$/);
  assert.match(r.message, /CHAT/, 'сообщение называет конкретный сервис');
  assert.match(r.message, /repository_path/, 'сообщение указывает, что нужно задать');
});

test('preflight: путь указывает на несуществующий каталог (корень виден) → missing_repository_path', async () => {
  const root = makeTree(['CRM/Other']); // каталога сервиса нет, по коду не найти
  const c = svcClient({ service_code: 'GETWAY', repository_path: 'services/getway', root_path: root });
  const r = await preflightServiceRepoPath(c, 'svc-2');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'missing_repository_path');
  assert.match(r.reason, /GETWAY/);
});

test('preflight: пустой repository_path, но рядом каталог с именем=кода (корень виден) → missing_repository_path (бэкфилл НЕ маскирует)', async () => {
  // Регрессия ревью: repository_path=NULL + ДОСТУПНЫЙ корень + каталог CHAT рядом.
  // Claim на хосте угадал бы каталог по коду (findServiceDirByCode) и продолжил, но
  // для РАННЕГО диагноза сохранённый путь фактически не задан → провал ДО Programmer.
  const root = makeTree(['CHAT']);
  const c = svcClient({ service_code: 'CHAT', repository_path: null, root_path: root });
  const r = await preflightServiceRepoPath(c, 'svc-backfill');
  assert.equal(r.ok, false, 'бэкфилл по коду не должен маскировать пустой repository_path');
  assert.equal(r.code, 'missing_repository_path');
  assert.match(r.reason, /^missing_repository_path:CHAT$/);
  assert.match(r.message, /CHAT/, 'сообщение называет конкретный сервис');
});

// --- Ветка «валидный repository_path» → задача проходит дальше (ok) ---------------

test('preflight: валидный существующий каталог → ok (задача идёт дальше)', async () => {
  const root = makeTree(['CRM/Chat_Service']);
  const c = svcClient({ service_code: 'Chat_Service', repository_path: 'CRM/Chat_Service', root_path: root });
  const r = await preflightServiceRepoPath(c, 'svc-3');
  assert.deepEqual(r, { ok: true });
});

test('preflight: безопасный непустой путь при невидимом корне → ok (доверяем, проверит host-runner)', async () => {
  const c = svcClient({ service_code: 'CHAT', repository_path: 'CRM/Chat_Service', root_path: 'K:\\no\\such\\host\\root' });
  const r = await preflightServiceRepoPath(c, 'svc-4');
  assert.deepEqual(r, { ok: true });
});

// --- Края: нет сервиса на входе — это не наша ветка диагноза ----------------------

test('preflight: serviceId не задан → ok (проверять нечего)', async () => {
  const c = fakeClient([]);
  assert.deepEqual(await preflightServiceRepoPath(c, null), { ok: true });
  assert.equal(c.calls.length, 0, 'без serviceId в БД не ходим');
});

test('preflight: сервис не найден в реестре → ok (обычный маршрут разберётся)', async () => {
  const c = fakeClient([
    { re: /FROM services s JOIN projects p/, reply: { rowCount: 0, rows: [] } },
  ]);
  assert.deepEqual(await preflightServiceRepoPath(c, 'svc-missing'), { ok: true });
});

// --- Мультисервисный split Архитектора: preflight ДО материализации детей ---------
// Одиночный путь Архитектора preflight уже покрыт выше через preflightServiceRepoPath;
// здесь проверяем split-ветку applyReasoningVerdict (≥2 сервиса), где дети создаются
// сразу в CODING/PROGRAMMER — без раннего диагноза сервис без пути дошёл бы до Pipeline.

// Линейный маршрут проекта: Архитектор → Программист (как в archServiceSplit.test.js).
const LINEAR_ROUTE = buildRoute([
  { position: 0, enabled: true, taskStatus: 'ARCHITECTURE', roleCodes: ['ARCHITECT'] },
  { position: 1, enabled: true, taskStatus: 'CODING', roleCodes: ['PROGRAMMER'] },
]);

function architectClaimed(overrides = {}) {
  return {
    id: 'epic1', project_id: 'p1', description: 'Родительское описание', data_card: {},
    role_code: 'ARCHITECT', role_id: 'rArch', agentRunId: 'run1', status: 'ARCHITECTURE',
    current_stage_key: null, ...overrides,
  };
}

// Вердикт Архитектора с разбивкой на два зарегистрированных сервиса (SvcA, SvcB).
function splitVerdict() {
  return {
    status: 'READY', ok: true, summary: 's', findings: [], fields: {
      work_items: [
        { serviceCode: 'SvcA', title: 'A', files: [{ path: 'a.js', what: 'x' }] },
        { serviceCode: 'SvcB', title: 'B', files: [{ path: 'c.js', what: 'z' }] },
      ],
    },
  };
}

// preflight-ответ (JOIN services↔projects) диспетчеризуется по serviceId ($1).
function preflightBy(map) {
  return (_hits, params) => {
    const svc = map[params[0]];
    return svc ? { rowCount: 1, rows: [svc] } : { rowCount: 0, rows: [] };
  };
}

// Правило резолва сервисов проекта (resolveArchitectSplit / canonicalRows).
const twoServicesRule = { re: /FROM services WHERE project_id/, reply: { rowCount: 2, rows: [
  { id: 'sidA', service_code: 'SvcA' }, { id: 'sidB', service_code: 'SvcB' },
] } };

async function runArchitect(c) {
  return applyReasoningVerdict(c, architectClaimed(), {
    route: LINEAR_ROUTE, contract: { outputs: [] }, verdict: splitVerdict(),
    response: '', exchangeId: 'ex1', durationMs: 1,
  });
}

test('split: один из сервисов без валидного repository_path → эпик BLOCKED, детей нет', async () => {
  const c = fakeClient([
    { re: /FROM services s JOIN projects p/, reply: preflightBy({
      // SvcA: безопасный непустой путь при невидимом корне → доверяем (ok).
      sidA: { service_code: 'SvcA', repository_path: 'CRM/SvcA', root_path: 'K:\\no\\such\\host\\root' },
      // SvcB: repository_path пуст, корень невидим — бэкфиллить нечем → провал.
      sidB: { service_code: 'SvcB', repository_path: null, root_path: 'K:\\no\\such\\host\\root' },
    }) },
    twoServicesRule,
  ]);

  const res = await runArchitect(c);
  assert.equal(res.toStatus, 'BLOCKED', 'эпик заблокирован ДО материализации');
  assert.match(res.reason, /^missing_repository_path:/);
  assert.match(res.reason, /SvcB/, 'причина называет проблемный сервис');

  const svcInserts = c.calls.filter((q) => /INSERT INTO tasks[\s\S]*'service'[\s\S]*RETURNING id/.test(q.sql));
  assert.equal(svcInserts.length, 0, 'детей не создаём — блок раньше материализации');

  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql) && /TASK_BLOCKED/.test(q.sql));
  assert.ok(ev, 'событие TASK_BLOCKED записано');
  const payload = JSON.parse(ev.params[3]);
  assert.equal(payload.event, 'missing_repository_path');
  assert.match(payload.detail, /SvcB/, 'detail поясняет, какой сервис и что указать');
});

test('split: все сервисы с валидным repository_path → дети создаются, эпик WAITING_FOR_CHILDREN', async () => {
  const c = fakeClient([
    { re: /FROM services s JOIN projects p/, reply: preflightBy({
      sidA: { service_code: 'SvcA', repository_path: 'CRM/SvcA', root_path: 'K:\\no\\such\\host\\root' },
      sidB: { service_code: 'SvcB', repository_path: 'CRM/SvcB', root_path: 'K:\\no\\such\\host\\root' },
    }) },
    { re: /FROM tasks WHERE parent_task_id = \$1 LIMIT 1/, reply: { rowCount: 0, rows: [] } },
    twoServicesRule,
    { re: /FROM roles WHERE code = \$1/, reply: { rowCount: 1, rows: [{ id: 'rProg' }] } },
    { re: /INSERT INTO tasks[\s\S]*'service'[\s\S]*RETURNING id/, reply: (h) => ({ rowCount: 1, rows: [{ id: `child-${h}` }] }) },
  ]);

  const res = await runArchitect(c);
  assert.equal(res.toStatus, 'WAITING_FOR_CHILDREN', 'валидные пути → штатная материализация');
  assert.equal(res.services, 2);
  assert.equal(res.nextRole, 'PROGRAMMER');

  const svcInserts = c.calls.filter((q) => /INSERT INTO tasks[\s\S]*'service'[\s\S]*RETURNING id/.test(q.sql));
  assert.equal(svcInserts.length, 2, 'две независимые задачи-на-сервис созданы');
});

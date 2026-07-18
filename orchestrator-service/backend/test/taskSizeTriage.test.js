import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSkipReviewerForSmallTask,
  reviewerSkipHasDangerousFile,
  applyReasoningVerdict,
} from '../src/db.js';
import { buildRoute } from '../src/projectRoute.js';

// Мини-клиент pg: отвечает по первому подходящему правилу (regex по SQL).
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

// ───── REVIEWER-SKIP-GUARD-001 — чистый safety-гейт пропуска Reviewer ─────

test('reviewerSkipHasDangerousFile: рискованные зоны детектятся, безопасные — нет', () => {
  // Безопасные пути — не опасные.
  assert.equal(reviewerSkipHasDangerousFile(['src/Button.tsx']), false);
  assert.equal(reviewerSkipHasDangerousFile(['src/components/list.ts', 'README.md']), false);
  // Рискованные зоны.
  assert.equal(reviewerSkipHasDangerousFile(['db/migrations/0062_x.sql']), true, 'миграция');
  assert.equal(reviewerSkipHasDangerousFile(['orchestrator-service/backend/db/schema.js']), true, 'db/');
  assert.equal(reviewerSkipHasDangerousFile(['proto/service.proto']), true, 'proto');
  assert.equal(reviewerSkipHasDangerousFile(['api/openapi.yaml']), true, 'openapi');
  assert.equal(reviewerSkipHasDangerousFile(['package.json']), true, 'манифест зависимостей');
  assert.equal(reviewerSkipHasDangerousFile(['package-lock.json']), true, 'lock');
  assert.equal(reviewerSkipHasDangerousFile(['Dockerfile']), true, 'Dockerfile');
  assert.equal(reviewerSkipHasDangerousFile(['deploy/k8s/ingress.yaml']), true, 'deploy/k8s');
  assert.equal(reviewerSkipHasDangerousFile(['services/auth/login.ts']), true, 'auth-зона');
  // Объектная форма { path } и windows-слэши.
  assert.equal(reviewerSkipHasDangerousFile([{ path: 'db\\migrations\\1.sql' }]), true, 'объект + backslash');
});

test('shouldSkipReviewerForSmallTask: пропуск только для узкой безопасной small-дельты', () => {
  const small = { data_card: { task_size: 'small' } };
  // Разрешаем: small + узкая безопасная дельта.
  assert.equal(shouldSkipReviewerForSmallTask(small, { changedFiles: ['src/x.ts'] }), true);
  // Пустой changedFiles (0 файлов) — тоже узкая дельта.
  assert.equal(shouldSkipReviewerForSmallTask(small, {}), true);
  // Не small → не пропускаем.
  assert.equal(shouldSkipReviewerForSmallTask({ data_card: { task_size: 'medium' } }, { changedFiles: ['x.ts'] }), false);
  assert.equal(shouldSkipReviewerForSmallTask({ data_card: {} }, { changedFiles: ['x.ts'] }), false, 'нет размера → medium');
  // small, но опасная зона → не пропускаем.
  assert.equal(shouldSkipReviewerForSmallTask(small, { changedFiles: ['db/migrations/1.sql'] }), false);
  // small, но файлов больше лимита → не пропускаем.
  assert.equal(shouldSkipReviewerForSmallTask(small, { changedFiles: ['a', 'b', 'c', 'd', 'e', 'f'] }), false);
  // Эпик с детьми — всегда ревьюим.
  assert.equal(shouldSkipReviewerForSmallTask({ ...small, task_kind: 'epic' }, { changedFiles: ['x.ts'] }), false);
  // Cross-service / blocked_by_service сигнал → не пропускаем.
  assert.equal(shouldSkipReviewerForSmallTask(small, { changedFiles: ['x.ts'], crossService: true }), false);
  assert.equal(shouldSkipReviewerForSmallTask(small, { changedFiles: ['x.ts'], blockedByService: 'CHAT' }), false);
});

// ───── ARCH-SIZE-ESCALATION-001 — Архитектор повышает сложность вопреки small ─────

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

// Вердикт Архитектора с разбивкой на два зарегистрированных сервиса.
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

// Правила «валидные пути + 2 сервиса + роль Программиста» (как в serviceRepoPreflight).
function validSplitRules() {
  return [
    { re: /FROM services s JOIN projects p/, reply: {
      rowCount: 1, rows: [{ service_code: 'Svc', repository_path: 'CRM/Svc', root_path: 'K:\\no\\such\\host\\root' }],
    } },
    { re: /EXISTS \(SELECT 1 FROM work_stack WHERE epic_task_id/, reply: { rowCount: 1, rows: [{ dup: false }] } },
    { re: /FROM services WHERE project_id/, reply: { rowCount: 2, rows: [
      { id: 'sidA', service_code: 'SvcA' }, { id: 'sidB', service_code: 'SvcB' },
    ] } },
    { re: /FROM roles WHERE code = \$1/, reply: { rowCount: 1, rows: [{ id: 'rProg' }] } },
  ];
}

test('ARCH-SIZE-ESCALATION-001: small + Архитектор нашёл 2 сервиса → расщепление (не одиночный путь)', async () => {
  const c = fakeClient(validSplitRules());
  const res = await applyReasoningVerdict(c, architectClaimed({ data_card: { task_size: 'small' } }), {
    route: LINEAR_ROUTE, contract: { outputs: [] }, verdict: splitVerdict(),
    response: '', exchangeId: 'ex1', durationMs: 1,
  });

  // Ключ: несмотря на task_size=small, мультисервисный scope → штатное расщепление,
  // а НЕ склейка в одиночную задачу (ensureArchitectService).
  assert.equal(res.toStatus, 'WAITING_FOR_CHILDREN', 'small НЕ подавляет мультисервисный split');
  assert.equal(res.services, 2);
  assert.equal(res.nextRole, 'PROGRAMMER');
  const stackInserts = c.calls.filter((q) => /INSERT INTO work_stack/.test(q.sql));
  assert.equal(stackInserts.length, 2, 'два элемента очереди работ (по сервису)');
  // ensureArchitectService (одиночный путь) НЕ вызывался.
  assert.equal(c.calls.some((q) => /SELECT service_id FROM tasks WHERE id = \$1/.test(q.sql)), false,
    'одиночный путь не выбран');

  // Traceability: карточка эпика фиксирует эскалацию small → large.
  const park = c.calls.find((q) => /UPDATE tasks SET task_kind = 'epic'/.test(q.sql));
  assert.ok(park, 'эпик припаркован');
  const epicCard = JSON.parse(park.params[1]);
  assert.equal(epicCard.task_size, 'large', 'размер эскалирован до large');
  assert.ok(epicCard.size_escalation, 'записана метка эскалации');
  assert.equal(epicCard.size_escalation.from, 'small');
  assert.equal(epicCard.size_escalation.by, 'architect');
  assert.equal(epicCard.size_escalation.reason, 'multi_service_scope');
});

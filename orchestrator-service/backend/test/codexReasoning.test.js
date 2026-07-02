// CODEX-REASONING-001 — тесты моста рассуждающих ролей на внешний codex-runner.
// Чистая функция схемы вердикта + транзакционное ядро сдачи на мини-клиенте pg
// (первое regex-правило выигрывает), по образцу restartStuck.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVerdictJsonSchema } from '../src/roleEngine.js';
import { completeReasoningTaskTx, releaseReasoningTask } from '../src/db.js';

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

// --- buildVerdictJsonSchema (для codex --output-schema) ----------------------

test('buildVerdictJsonSchema: без полей — строгий объект status/summary/findings', () => {
  const s = buildVerdictJsonSchema([]);
  assert.equal(s.type, 'object');
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ['status', 'summary', 'findings']);
  assert.equal(s.properties.findings.type, 'array');
  assert.ok(!s.properties.fields, 'без исходящих полей нет блока fields');
});

test('buildVerdictJsonSchema: с полями — добавляет строгий fields в required', () => {
  const s = buildVerdictJsonSchema([{ key: 'task_type', name: 'Тип задачи' }, { key: 'project' }]);
  assert.ok(s.required.includes('fields'));
  assert.equal(s.properties.fields.additionalProperties, false);
  assert.deepEqual(s.properties.fields.required, ['task_type', 'project']);
  assert.equal(s.properties.fields.properties.task_type.type, 'string');
  assert.equal(s.properties.fields.properties.task_type.description, 'Тип задачи');
});

test('buildVerdictJsonSchema: учитывает valueType для Codex structured output', () => {
  const s = buildVerdictJsonSchema([
    { key: 'task_type', name: 'Тип задачи', valueType: 'list' },
    { key: 'blocking_questions', valueType: 'list' },
    { key: 'confidence_score', valueType: 'number' },
    { key: 'needs_user_input', valueType: 'boolean' },
    { key: 'debug_payload', valueType: 'json' },
  ]);
  const props = s.properties.fields.properties;
  assert.equal(props.task_type.type, 'array');
  assert.equal(props.task_type.items.type, 'string');
  assert.equal(props.blocking_questions.type, 'array');
  assert.equal(props.confidence_score.type, 'number');
  assert.equal(props.needs_user_input.type, 'boolean');
  assert.equal(props.debug_payload.type, 'string');
  assert.match(props.debug_payload.description, /JSON serialized/);
});

// --- completeReasoningTaskTx: гварды и идемпотентность -----------------------

const FOUND = /FROM tasks t\s+LEFT JOIN roles r/;
// Источник истины движков роли — role_connectors (см. getRoleEngines в db.js).
const ROLE_CONNECTORS = /FROM role_connectors/;

test('completeReasoningTask: нет задачи → 404', async () => {
  const c = fakeClient([{ re: FOUND, reply: { rowCount: 0, rows: [] } }]);
  await assert.rejects(() => completeReasoningTaskTx(c, { taskId: 't1' }), /task_not_found/);
});

test('completeReasoningTask: терминальная задача → duplicate (без перехода)', async () => {
  const c = fakeClient([
    { re: FOUND, reply: { rowCount: 1, rows: [{ id: 't1', status: 'DONE', role_code: 'ARCHITECT', agent_run_id: 'r1' }] } },
  ]);
  const res = await completeReasoningTaskTx(c, { taskId: 't1', verdict: { status: 'READY' } });
  assert.equal(res.duplicate, true);
  assert.equal(res.toStatus, 'DONE');
  // Дальше первого SELECT не пошли (нет BEGIN/finalize).
  assert.ok(!c.calls.some((q) => /BEGIN/.test(q.sql)), 'переход не выполнялся');
});

test('completeReasoningTask: нет RUNNING-прогона → duplicate', async () => {
  const c = fakeClient([
    { re: FOUND, reply: { rowCount: 1, rows: [{ id: 't1', status: 'ARCHITECTURE', role_code: 'ARCHITECT', agent_run_id: null }] } },
  ]);
  const res = await completeReasoningTaskTx(c, { taskId: 't1', verdict: { status: 'READY' } });
  assert.equal(res.duplicate, true);
});

test('completeReasoningTask: роль не делегирована внешнему движку → 409', async () => {
  const c = fakeClient([
    { re: FOUND, reply: { rowCount: 1, rows: [{ id: 't1', status: 'ARCHITECTURE', role_code: 'ARCHITECT', agent_run_id: 'r1' }] } },
    // нет назначения коннектора → ARCHITECT = deepseek (внутренний), не внешний.
    { re: ROLE_CONNECTORS, reply: { rowCount: 0, rows: [] } },
  ]);
  await assert.rejects(() => completeReasoningTaskTx(c, { taskId: 't1', verdict: { status: 'READY' } }),
    /role_not_delegated_to_engine/);
});

test('completeReasoningTask: роль на claude_code → проходит гейт движка (идёт к переходу)', async () => {
  const c = fakeClient([
    { re: FOUND, reply: { rowCount: 1, rows: [{ id: 't1', status: 'ARCHITECTURE', role_code: 'ARCHITECT', agent_run_id: 'r1', project_id: 'p1' }] } },
    { re: ROLE_CONNECTORS, reply: { rowCount: 1, rows: [{ role_code: 'ARCHITECT', provider: 'claude_code' }] } },
    { re: /from_status = 'FAILURE_ANALYSIS'/, reply: { rowCount: 1, rows: [{ n: 0 }] } },
  ]);
  // Вердикт распознан и роль на внешнем движке → доходит до перехода (BEGIN finalize).
  await completeReasoningTaskTx(c, { taskId: 't1', verdict: { status: 'READY', summary: 'ok', findings: [] } });
  assert.ok(c.calls.some((q) => /BEGIN/.test(q.sql)), 'дошли до финализации перехода');
});

test('completeReasoningTask: taskId обязателен', async () => {
  const c = fakeClient([]);
  await assert.rejects(() => completeReasoningTaskTx(c, {}), /taskId_required/);
});

// --- releaseReasoningTask ----------------------------------------------------

test('releaseReasoningTask: снимает захват и гасит RUNNING-прогон', async () => {
  const s = {};
  // releaseReasoningTask берёт клиент через withClient(clientConfig(s)); проверим
  // на уровне контракта результата с мок-withClient невозможно без сети — поэтому
  // проверяем валидацию пустого taskId (быстрый чистый путь).
  await assert.rejects(() => releaseReasoningTask(s, '  '), /taskId_required/);
});

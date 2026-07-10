// CODEX-REASONING-001 — тесты моста рассуждающих ролей на внешний codex-runner.
// Чистая функция схемы вердикта + транзакционное ядро сдачи на мини-клиенте pg
// (первое regex-правило выигрывает), по образцу restartStuck.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVerdictJsonSchema } from '../src/roleEngine.js';
import { completeReasoningTaskTx, releaseReasoningTask, normalizeRunKpi } from '../src/db.js';

// TOKEN-SPLIT-001 — нормализация разбивки входа из тела сдачи раннера.
test('normalizeRunKpi: разбивка входа (cache_read/cache_creation) округляется, отсутствие → null', () => {
  const kpi = normalizeRunKpi({
    tokensIn: 9200, tokensOut: 300, tokensCacheRead: 8000.4, tokensCacheCreation: 200.9, costUsd: 0.5,
  });
  assert.equal(kpi.tokenInput, 9200);
  assert.equal(kpi.tokenCacheRead, 8000);
  assert.equal(kpi.tokenCacheCreation, 201);
  // Движок без prompt-кэша (codex/deepseek) разбивку не шлёт → null (COALESCE не затрёт).
  const bare = normalizeRunKpi({ tokensIn: 100, tokensOut: 10 });
  assert.equal(bare.tokenCacheRead, null);
  assert.equal(bare.tokenCacheCreation, null);
});

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

// --- VERDICT-RETRY-001: неразобранный вердикт → авто-ретрай, затем терминал --------
const REWORK_COUNT = /from_status = 'FAILURE_ANALYSIS'/;
const UNPARSED_COUNT = /output_json->>'reason' = 'verdict_unparsed'/;

// Правила для пути verdict_unparsed у роли на claude_code. unparsedCount — сколько
// FAILED-прогонов с reason=verdict_unparsed насчитает failRoleUnparsed (вкл. текущий).
function unparsedRules(unparsedCount) {
  return [
    { re: FOUND, reply: { rowCount: 1, rows: [{
      id: 't1', status: 'REVIEW', role_code: 'TASK_REVIEWER', role_id: 'role-rev',
      agent_run_id: 'run-1', project_id: 'p1',
    }] } },
    { re: ROLE_CONNECTORS, reply: { rowCount: 1, rows: [{ role_code: 'TASK_REVIEWER', provider: 'claude_code' }] } },
    { re: REWORK_COUNT, reply: { rowCount: 1, rows: [{ n: 0 }] } },
    { re: /INSERT INTO prompt_exchanges/, reply: { rowCount: 1, rows: [{ id: 'ex1' }] } },
    { re: UNPARSED_COUNT, reply: { rowCount: 1, rows: [{ n: unparsedCount }] } },
  ];
}

test('completeReasoningTask: неразобранный вердикт (1-й раз) → авто-ретрай (release, не терминал)', async () => {
  const c = fakeClient(unparsedRules(1)); // n=1 <= RUNNER_MAX_VERDICT_RETRY(1) → ретрай
  const res = await completeReasoningTaskTx(c, { taskId: 't1', response: 'болтовня без JSON и YAML' });
  assert.equal(res.toStatus, null);
  assert.equal(res.retried, true);
  assert.equal(res.reason, 'verdict_unparsed');
  // Прогон помечен FAILED, задача освобождена (assigned_agent_id=NULL), НЕ в терминал.
  assert.ok(c.calls.some((q) => /UPDATE agent_runs SET status = 'FAILED'/.test(q.sql)), 'прогон FAILED');
  assert.ok(c.calls.some((q) => /UPDATE tasks SET assigned_agent_id = NULL/.test(q.sql)), 'задача освобождена');
  assert.ok(!c.calls.some((q) => /UPDATE tasks SET status = 'FAILED'/.test(q.sql)), 'без терминального FAILED');
  assert.ok(!c.calls.some((q) => /INSERT INTO task_events/.test(q.sql)), 'без события перехода при ретрае');
});

test('completeReasoningTask: неразобранный вердикт (лимит исчерпан) → терминальный FAILED', async () => {
  const c = fakeClient(unparsedRules(2)); // n=2 > RUNNER_MAX_VERDICT_RETRY(1) → терминал
  const res = await completeReasoningTaskTx(c, { taskId: 't1', response: 'опять без вердикта' });
  assert.equal(res.toStatus, 'FAILED');
  assert.equal(res.reason, 'verdict_unparsed');
  assert.ok(!res.retried);
  assert.ok(c.calls.some((q) => /UPDATE tasks SET status = 'FAILED'/.test(q.sql)), 'терминальный FAILED');
  assert.ok(c.calls.some((q) => /INSERT INTO task_events/.test(q.sql)), 'событие STATUS_CHANGED→FAILED');
});

// --- releaseReasoningTask ----------------------------------------------------

test('releaseReasoningTask: снимает захват и гасит RUNNING-прогон', async () => {
  const s = {};
  // releaseReasoningTask берёт клиент через withClient(clientConfig(s)); проверим
  // на уровне контракта результата с мок-withClient невозможно без сети — поэтому
  // проверяем валидацию пустого taskId (быстрый чистый путь).
  await assert.rejects(() => releaseReasoningTask(s, '  '), /taskId_required/);
});

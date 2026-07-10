// TASK-DUPLICATE-CLOSE-001 — дедуп повторной подачи задач: отпечаток текста
// (messageFingerprint) + поиск живого оригинала (findDuplicateTaskTx).
// Мини-клиент pg — как в hostTaskForkContext.test.js (ответ по первому regex-правилу).
import test from 'node:test';
import assert from 'node:assert/strict';
import { messageFingerprint } from '../src/intakeIntegrations.js';
import { findDuplicateTaskTx, reattachBlockedOwnerRoles } from '../src/db.js';

function fakeClient(rules = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const rule of rules) {
        if (rule.re.test(sql)) {
          const out = typeof rule.reply === 'function' ? rule.reply(params) : rule.reply;
          return out ?? { rows: [], rowCount: 0 };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// --- messageFingerprint -------------------------------------------------------
test('messageFingerprint: детерминирован, регистр/пробелы не влияют', () => {
  const a = messageFingerprint('column t.structured_data_json does not exist');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, messageFingerprint('  COLUMN   t.structured_data_json\n\nDOES not  EXIST  '));
  assert.notEqual(a, messageFingerprint('другой текст обращения'));
});

test('reattachBlockedOwnerRoles: BLOCKED с NULL role чинится по task_events/agent_runs без смены статуса', async () => {
  const c = fakeClient([
    { re: /WITH orphan AS \([\s\S]*t\.status = 'BLOCKED'[\s\S]*blocked_owner_role_reattached/, reply: { rowCount: 2, rows: [] } },
  ]);
  const n = await reattachBlockedOwnerRoles(c);
  assert.equal(n, 2);
  assert.equal(c.calls.length, 1);
  assert.match(c.calls[0].sql, /SELECT te\.role_id FROM task_events/);
  assert.match(c.calls[0].sql, /SELECT ar\.role_id FROM agent_runs/);
  assert.match(c.calls[0].sql, /status::task_status, status::task_status/);
});

test('messageFingerprint: пустой/пробельный вход → "" (дедуп не применяется)', () => {
  assert.equal(messageFingerprint(''), '');
  assert.equal(messageFingerprint('   \n\t '), '');
  assert.equal(messageFingerprint(null), '');
  assert.equal(messageFingerprint(undefined), '');
});

test('messageFingerprint: юникод нормализуется (NFC)', () => {
  // е + combining diaeresis (NFD) === ё (NFC)
  assert.equal(messageFingerprint('ошибка в отчёте'), messageFingerprint('ошибка в отчёте'));
});

// --- findDuplicateTaskTx ------------------------------------------------------
const INTAKE_RE = /WHERE intake_integration_id = \$1 AND data_card->>'messageFingerprint' = \$2/;
const PROJECT_RE = /WHERE project_id = \$1 AND data_card->>'messageFingerprint' = \$2/;
const NULLPOOL_RE = /WHERE project_id IS NULL AND data_card->>'messageFingerprint' = \$1/;

test('findDuplicateTaskTx: пустой отпечаток → null без запросов', async () => {
  const c = fakeClient();
  assert.equal(await findDuplicateTaskTx(c, { intakeIntegrationId: 'int-1', fingerprint: '' }), null);
  assert.equal(c.calls.length, 0);
});

test('findDuplicateTaskTx: скоуп канала интеграции, возвращает оригинал', async () => {
  const c = fakeClient([
    { re: INTAKE_RE, reply: { rowCount: 1, rows: [{ id: 'orig-1', title: 'Оригинал' }] } },
  ]);
  const hit = await findDuplicateTaskTx(c, { intakeIntegrationId: 'int-1', fingerprint: 'f'.repeat(64) });
  assert.equal(hit.id, 'orig-1');
  assert.equal(c.calls.length, 1);
  assert.deepEqual(c.calls[0].params, ['int-1', 'f'.repeat(64)]);
  // терминальные статусы исключены из поиска — дубль ищем только среди живых
  assert.match(c.calls[0].sql, /NOT IN \('DONE','CANCELLED','FAILED'\)/);
});

test('findDuplicateTaskTx: скоуп проекта и NULL-пула неразобранных', async () => {
  const cProj = fakeClient([{ re: PROJECT_RE, reply: { rowCount: 1, rows: [{ id: 'p-1', title: 'x' }] } }]);
  const hitProj = await findDuplicateTaskTx(cProj, { projectId: 'proj-1', fingerprint: 'ab' });
  assert.equal(hitProj.id, 'p-1');
  assert.deepEqual(cProj.calls[0].params, ['proj-1', 'ab']);

  const cNull = fakeClient([{ re: NULLPOOL_RE, reply: { rowCount: 1, rows: [{ id: 'n-1', title: 'y' }] } }]);
  const hitNull = await findDuplicateTaskTx(cNull, { projectId: null, fingerprint: 'cd' });
  assert.equal(hitNull.id, 'n-1');
  assert.deepEqual(cNull.calls[0].params, ['cd']);
});

test('findDuplicateTaskTx: живого оригинала нет → null', async () => {
  const c = fakeClient([{ re: INTAKE_RE, reply: { rowCount: 0, rows: [] } }]);
  assert.equal(await findDuplicateTaskTx(c, { intakeIntegrationId: 'int-1', fingerprint: 'ff' }), null);
});

// PIPELINE-PRIOR-DEDUP-001 — дедуп priorRoleOutputs: последний SUCCESS-прогон на
// роль. Мини-клиент pg (как в reapOrphanRuns.test.js) не исполняет SQL, поэтому
// дедуп (он делегирован БД через DISTINCT ON) проверяем двумя углами: (1) форма
// запроса гарантирует ≤1 последнюю строку на роль в хронологии started_at;
// (2) строки, которые БД так вернёт, корректно пробрасываются в priorRoleOutputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPriorOutputs } from '../src/db.js';

function fakeClient(rules = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const rule of rules) {
        if (rule.re.test(sql)) return rule.reply ?? { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// Запрос прошлых прогонов — единственный по agent_runs+roles.
const PRIOR_RE = /FROM agent_runs ar JOIN roles r/;

test('fetchPriorOutputs: запрос оставляет только последний SUCCESS-прогон каждой роли (дедуп по r.code)', async () => {
  const c = fakeClient([
    { re: PRIOR_RE, reply: { rows: [], rowCount: 0 } },
    { re: /FROM reviews/, reply: { rows: [], rowCount: 0 } },
  ]);

  await fetchPriorOutputs(c, 42);

  const q = c.calls.find((x) => PRIOR_RE.test(x.sql));
  assert.ok(q, 'запрос прошлых прогонов вызван');
  // (крит.1) дедуп по роли: ровно одна строка на роль...
  assert.match(q.sql, /DISTINCT ON \(r\.code\)/, 'дедуп по роли через DISTINCT ON (r.code)');
  // ...именно ПОСЛЕДНЯЯ по времени (started_at DESC внутри подзапроса).
  assert.match(q.sql, /ORDER BY r\.code, ar\.started_at DESC/, 'внутри подзапроса — последний прогон роли');
  // (крит.2) итоговая хронология по started_at последних прогонов (контракт summarizePriorRuns не меняется).
  assert.match(q.sql, /ORDER BY latest\.started_at/, 'снаружи — хронология ролей по started_at');
  // Границы выборки прежние: только SUCCESS с непустым output_json.
  assert.match(q.sql, /ar\.status = 'SUCCESS'/, 'только SUCCESS-прогоны');
  assert.match(q.sql, /ar\.output_json IS NOT NULL/, 'только прогоны с output_json');
  assert.deepEqual(q.params, [42], 'параметр запроса — task_id');
});

test('fetchPriorOutputs: строки БД (по одной, последней, на роль) пробрасываются в priorRoleOutputs в хронологии', async () => {
  // Так и вернёт DISTINCT ON: по одной строке на роль (последний прогон), в
  // хронологии started_at — DECOMPOSER раньше повторно прошедшего ARCHITECT.
  // Т.е. из нескольких SUCCESS-прогонов ARCHITECT в контекст попадает только
  // последний (дизайн v2), а не портянка всех попыток.
  const dedupedRows = [
    { role_code: 'DECOMPOSER', status: 'SUCCESS', output_json: { status: 'READY', summary: 'разбивка' } },
    { role_code: 'ARCHITECT', status: 'SUCCESS', output_json: { status: 'READY', summary: 'дизайн v2', findings: ['a'] } },
  ];
  const c = fakeClient([
    { re: PRIOR_RE, reply: { rows: dedupedRows, rowCount: dedupedRows.length } },
    { re: /FROM reviews/, reply: { rows: [{ status: 'APPROVED', review_text: 'ок' }], rowCount: 1 } },
  ]);

  const out = await fetchPriorOutputs(c, 7);

  assert.deepEqual(out.priorRoleOutputs, [
    { role: 'DECOMPOSER', status: 'READY', summary: 'разбивка', findings: [] },
    { role: 'ARCHITECT', status: 'READY', summary: 'дизайн v2', findings: ['a'] },
  ]);
  // Ровно одна запись на роль (крит.1).
  const roles = out.priorRoleOutputs.map((o) => o.role);
  assert.deepEqual([...new Set(roles)], roles, 'по одной записи на роль');
  // Последнее ревью пробрасывается прежним контрактом.
  assert.deepEqual(out.lastReview, { status: 'APPROVED', text: 'ок' });
});

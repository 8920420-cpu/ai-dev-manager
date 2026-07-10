// ROLE-CONNECTOR-REASONING-ONLY-001 — валидация: движок (коннектор) можно
// назначить только рассуждающим ролям. Тесты чистой функции normalizeRoleConnectors
// (без БД и сети), по образцу businessStore.test.js / fields.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoleConnectors } from '../src/roleConnectors.js';
import { LLM_ROLE_CODES } from '../src/roleEngine.js';

// Набор рассуждающих ролей — единственно допустимых к назначению движка. Строим
// так же, как saveRoleConnectors (UPPER/TRIM из LLM_ROLE_CODES).
const reasoningRoleCodes = new Set(LLM_ROLE_CODES.map((c) => String(c).trim().toUpperCase()));

// Допустимые коды ролей и id коннекторов (как их вернул бы запрос к БД).
const validRoleCodes = new Set([
  'PIPELINE_SERVICE',
  'GIT_INTEGRATOR',
  'SCANNER',
  'PROGRAMMER',
  ...LLM_ROLE_CODES,
]);
const validConnectorIds = new Set(['conn-1']);
const opts = { validRoleCodes, validConnectorIds, reasoningRoleCodes };

test('назначение коннектора PIPELINE_SERVICE → 422 role_connector_role_not_reasoning', () => {
  assert.throws(
    () => normalizeRoleConnectors(
      { assignments: [{ roleCode: 'PIPELINE_SERVICE', connectorId: 'conn-1' }] },
      opts,
    ),
    (e) => e.statusCode === 422 && e.code === 'role_connector_role_not_reasoning',
  );
});

test('назначение коннектора SCANNER → 422 role_connector_role_not_reasoning', () => {
  assert.throws(
    () => normalizeRoleConnectors(
      { assignments: [{ roleCode: 'SCANNER', connectorId: 'conn-1' }] },
      opts,
    ),
    (e) => e.statusCode === 422 && e.code === 'role_connector_role_not_reasoning',
  );
});

test('connectorId=null для не-reasoning роли — снятие разрешено', () => {
  const out = normalizeRoleConnectors(
    { assignments: [{ roleCode: 'PIPELINE_SERVICE', connectorId: null }] },
    opts,
  );
  assert.deepEqual(out, [{ roleCode: 'PIPELINE_SERVICE', connectorId: null }]);
});

test('назначение коннектора ARCHITECT (reasoning) — ок', () => {
  const out = normalizeRoleConnectors(
    { assignments: [{ roleCode: 'ARCHITECT', connectorId: 'conn-1' }] },
    opts,
  );
  assert.deepEqual(out, [{ roleCode: 'ARCHITECT', connectorId: 'conn-1' }]);
});

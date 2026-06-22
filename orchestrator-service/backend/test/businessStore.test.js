// LEGACY-BUSINESS-STORAGE-API-001 — юнит-тесты ЧИСТЫХ функций (без БД).
// Покрытие: validateStatus, mapProjectRow, isConcurrencyConflict (projects.js),
// redactAdditionalDb (additionalDatabases.js), normalizeRoleConnectors
// (roleConnectors.js), planImport + ключи (importLegacy.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStatus,
  mapProjectRow,
  isConcurrencyConflict,
  PROJECT_STATUSES,
} from '../src/projects.js';
import { redactAdditionalDb } from '../src/additionalDatabases.js';
import { normalizeRoleConnectors } from '../src/roleConnectors.js';
import {
  planImport,
  projectKey,
  additionalDbKey,
  roleConnectorKey,
} from '../src/importLegacy.js';

// --- projects: validateStatus ----------------------------------------------

test('validateStatus: только active|paused|draft|archived валидны', () => {
  for (const ok of PROJECT_STATUSES) assert.equal(validateStatus(ok), true);
  assert.equal(validateStatus('active'), true);
  assert.equal(validateStatus('deleted'), false);
  assert.equal(validateStatus(''), false);
  assert.equal(validateStatus(undefined), false);
  assert.equal(validateStatus('ACTIVE'), false); // регистрозависимо
});

// --- projects: mapProjectRow -----------------------------------------------

test('mapProjectRow: path = root_path, есть алиас rootPath, databaseId = database_ref', () => {
  const row = {
    id: 'uuid-1',
    code: 'MY_PROJ',
    name: 'Мой проект',
    root_path: 'K:\\projects\\my',
    status: 'paused',
    database_ref: 'primary-postgres',
    created_at: new Date('2026-01-01T10:00:00Z'),
    updated_at: new Date('2026-01-02T11:00:00Z'),
  };
  const out = mapProjectRow(row, { stages: [{ id: 's1' }], roles: [{ id: 'r1', code: 'PROGRAMMER', name: 'Programmer' }] });
  assert.equal(out.id, 'uuid-1');
  assert.equal(out.code, 'MY_PROJ');
  assert.equal(out.name, 'Мой проект');
  assert.equal(out.path, 'K:\\projects\\my');
  assert.equal(out.rootPath, 'K:\\projects\\my'); // алиас совместимости
  assert.equal(out.status, 'paused');
  assert.equal(out.databaseId, 'primary-postgres');
  assert.deepEqual(out.stages, [{ id: 's1' }]);
  assert.deepEqual(out.roles, [{ id: 'r1', code: 'PROGRAMMER', name: 'Programmer' }]);
  assert.equal(out.createdAt, '2026-01-01T10:00:00.000Z');
  assert.equal(out.updatedAt, '2026-01-02T11:00:00.000Z');
});

test('mapProjectRow: значения по умолчанию (status=active, databaseId=null, пустые stages/roles)', () => {
  const out = mapProjectRow({ id: 'u', code: 'C', name: 'N', root_path: null });
  assert.equal(out.status, 'active');
  assert.equal(out.databaseId, null);
  assert.equal(out.path, null);
  assert.equal(out.rootPath, null);
  assert.deepEqual(out.stages, []);
  assert.deepEqual(out.roles, []);
});

// --- projects: isConcurrencyConflict ---------------------------------------

test('isConcurrencyConflict: нет токена → нет конфликта', () => {
  assert.equal(isConcurrencyConflict(null, '2026-01-01T00:00:00Z'), false);
  assert.equal(isConcurrencyConflict(undefined, '2026-01-01T00:00:00Z'), false);
  assert.equal(isConcurrencyConflict('', '2026-01-01T00:00:00Z'), false);
});

test('isConcurrencyConflict: совпадение момента времени → нет конфликта (разный формат)', () => {
  assert.equal(isConcurrencyConflict('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00Z'), false);
  assert.equal(
    isConcurrencyConflict('2026-01-01T00:00:00.000Z', new Date('2026-01-01T00:00:00Z')),
    false,
  );
});

test('isConcurrencyConflict: расхождение updatedAt → конфликт', () => {
  assert.equal(isConcurrencyConflict('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'), true);
});

// --- additionalDatabases: redactAdditionalDb -------------------------------

test('redactAdditionalDb: secret НИКОГДА не в ответе, hasSecret=true при наличии', () => {
  const row = {
    id: 'db-1',
    name: 'Аналитика',
    host: 'pg.local',
    port: 5433,
    database: 'analytics',
    db_user: 'reader',
    ssl_mode: 'require',
    secret: 'super-secret-pass',
    created_at: new Date('2026-02-01T00:00:00Z'),
    updated_at: new Date('2026-02-02T00:00:00Z'),
  };
  const out = redactAdditionalDb(row);
  assert.equal('secret' in out, false);
  assert.equal('password' in out, false);
  assert.equal(out.hasSecret, true);
  assert.equal(out.user, 'reader'); // db_user → user
  assert.equal(out.sslMode, 'require'); // ssl_mode → sslMode
  assert.equal(out.port, 5433);
  assert.equal(out.createdAt, '2026-02-01T00:00:00.000Z');
});

test('redactAdditionalDb: пустой/отсутствующий secret → hasSecret=false', () => {
  assert.equal(redactAdditionalDb({ id: 'x', secret: null }).hasSecret, false);
  assert.equal(redactAdditionalDb({ id: 'x', secret: '' }).hasSecret, false);
  assert.equal(redactAdditionalDb({ id: 'x', secret: '   ' }).hasSecret, false);
  // defaults
  const out = redactAdditionalDb({ id: 'x' });
  assert.equal(out.port, 5432);
  assert.equal(out.sslMode, 'disable');
  assert.equal(out.hasSecret, false);
});

// --- roleConnectors: normalizeRoleConnectors -------------------------------

const VALID_ROLES = new Set(['PROGRAMMER', 'ARCHITECT', 'SCANNER']);
const VALID_CONNECTORS = new Set(['c-1', 'c-2']);

test('normalizeRoleConnectors: валидный вход, connectorId:null снимает', () => {
  const out = normalizeRoleConnectors(
    { assignments: [
      { roleCode: 'PROGRAMMER', connectorId: 'c-1' },
      { roleCode: 'ARCHITECT', connectorId: null },
    ] },
    { validRoleCodes: VALID_ROLES, validConnectorIds: VALID_CONNECTORS },
  );
  assert.deepEqual(out, [
    { roleCode: 'PROGRAMMER', connectorId: 'c-1' },
    { roleCode: 'ARCHITECT', connectorId: null },
  ]);
});

test('normalizeRoleConnectors: дедуп по roleCode (последнее значение побеждает)', () => {
  const out = normalizeRoleConnectors(
    { assignments: [
      { roleCode: 'PROGRAMMER', connectorId: 'c-1' },
      { roleCode: 'PROGRAMMER', connectorId: 'c-2' },
    ] },
    { validRoleCodes: VALID_ROLES, validConnectorIds: VALID_CONNECTORS },
  );
  assert.deepEqual(out, [{ roleCode: 'PROGRAMMER', connectorId: 'c-2' }]);
});

test('normalizeRoleConnectors: пустой roleCode пропускается', () => {
  const out = normalizeRoleConnectors(
    { assignments: [{ roleCode: '  ', connectorId: 'c-1' }] },
    { validRoleCodes: VALID_ROLES, validConnectorIds: VALID_CONNECTORS },
  );
  assert.deepEqual(out, []);
});

test('normalizeRoleConnectors: неизвестная роль → 422 role_connector_invalid_role', () => {
  assert.throws(
    () => normalizeRoleConnectors(
      { assignments: [{ roleCode: 'GHOST', connectorId: 'c-1' }] },
      { validRoleCodes: VALID_ROLES, validConnectorIds: VALID_CONNECTORS },
    ),
    (e) => e.statusCode === 422 && e.code === 'role_connector_invalid_role',
  );
});

test('normalizeRoleConnectors: неизвестный коннектор → 422 role_connector_invalid_connector', () => {
  assert.throws(
    () => normalizeRoleConnectors(
      { assignments: [{ roleCode: 'PROGRAMMER', connectorId: 'c-404' }] },
      { validRoleCodes: VALID_ROLES, validConnectorIds: VALID_CONNECTORS },
    ),
    (e) => e.statusCode === 422 && e.code === 'role_connector_invalid_connector',
  );
});

test('normalizeRoleConnectors: пустой connectorId трактуется как null (снятие)', () => {
  const out = normalizeRoleConnectors(
    { assignments: [{ roleCode: 'SCANNER', connectorId: '' }] },
    { validRoleCodes: VALID_ROLES, validConnectorIds: VALID_CONNECTORS },
  );
  assert.deepEqual(out, [{ roleCode: 'SCANNER', connectorId: null }]);
});

// --- importLegacy: ключи ----------------------------------------------------

test('projectKey: нормализует path (трим, срез хвостового слеша)', () => {
  assert.equal(projectKey({ path: '  K:\\proj\\a\\ ' }), 'K:\\proj\\a');
  assert.equal(projectKey({ rootPath: '/home/x/' }), '/home/x');
  assert.equal(projectKey({}), '');
});

test('additionalDbKey: name+host+database в нижнем регистре', () => {
  assert.equal(additionalDbKey({ name: 'A', host: 'H', database: 'D' }), 'a|h|d');
  assert.equal(
    additionalDbKey({ name: 'A', host: 'H', database: 'D' }),
    additionalDbKey({ name: 'a', host: 'h', database: 'd' }),
  );
});

test('roleConnectorKey: roleCode (трим)', () => {
  assert.equal(roleConnectorKey({ roleCode: '  PROGRAMMER ' }), 'PROGRAMMER');
});

// --- importLegacy: planImport ----------------------------------------------

test('planImport: новые → create, существующие → conflict (не перезаписываем)', () => {
  const existing = new Set(['K:\\a']);
  const incoming = [{ path: 'K:\\a' }, { path: 'K:\\b' }];
  const plan = planImport({ existing, incoming, keyOf: projectKey });
  assert.equal(plan.create.length, 1);
  assert.equal(plan.create[0].key, 'K:\\b');
  assert.equal(plan.conflict.length, 1);
  assert.equal(plan.conflict[0].key, 'K:\\a');
  assert.equal(plan.skip.length, 0);
});

test('planImport: дедуп дубликатов внутри батча → skip(duplicate_in_batch)', () => {
  const plan = planImport({
    existing: new Set(),
    incoming: [{ path: 'K:\\b' }, { path: 'K:\\b\\' }],
    keyOf: projectKey,
  });
  assert.equal(plan.create.length, 1);
  assert.equal(plan.skip.length, 1);
  assert.equal(plan.skip[0].reason, 'duplicate_in_batch');
});

test('planImport: пустой ключ → skip(missing_key)', () => {
  const plan = planImport({ existing: new Set(), incoming: [{ path: '   ' }], keyOf: projectKey });
  assert.equal(plan.create.length, 0);
  assert.equal(plan.skip.length, 1);
  assert.equal(plan.skip[0].reason, 'missing_key');
});

test('planImport: повторный импорт идемпотентен (всё уже создано → 0 create)', () => {
  const incoming = [{ path: 'K:\\a' }, { path: 'K:\\b' }];
  // первый проход: оба новые
  const first = planImport({ existing: new Set(), incoming, keyOf: projectKey });
  assert.equal(first.create.length, 2);
  // эмулируем запись в БД → существующие теперь оба
  const afterWrite = new Set(first.create.map((x) => x.key));
  // повторный импорт того же набора
  const second = planImport({ existing: afterWrite, incoming, keyOf: projectKey });
  assert.equal(second.create.length, 0);
  assert.equal(second.conflict.length, 2);
});

test('planImport: дедуп доп.БД по name+host+database', () => {
  const incoming = [
    { name: 'A', host: 'h', database: 'd' },
    { name: 'a', host: 'H', database: 'D' }, // тот же ключ, иной регистр
    { name: 'B', host: 'h', database: 'd' },
  ];
  const plan = planImport({ existing: new Set(), incoming, keyOf: additionalDbKey });
  assert.equal(plan.create.length, 2); // A и B
  assert.equal(plan.skip.length, 1); // дубль A
});

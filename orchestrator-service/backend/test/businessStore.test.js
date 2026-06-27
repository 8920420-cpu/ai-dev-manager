// Юнит-тесты ЧИСТЫХ функций (без БД).
// Покрытие: validateStatus, mapProjectRow, isConcurrencyConflict (projects.js),
// normalizeRoleConnectors (roleConnectors.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStatus,
  mapProjectRow,
  isConcurrencyConflict,
  PROJECT_STATUSES,
} from '../src/projects.js';
import { normalizeRoleConnectors } from '../src/roleConnectors.js';

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

test('mapProjectRow: path = root_path, есть алиас rootPath, docsPath = docs_path', () => {
  const row = {
    id: 'uuid-1',
    code: 'MY_PROJ',
    name: 'Мой проект',
    root_path: 'K:\\projects\\my',
    status: 'paused',
    docs_path: 'K:\\projects\\my\\docs',
    tasks_path: 'K:\\projects\\my\\tasks',
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
  assert.equal(out.docsPath, 'K:\\projects\\my\\docs');
  assert.equal(out.tasksPath, 'K:\\projects\\my\\tasks');
  assert.deepEqual(out.stages, [{ id: 's1' }]);
  assert.deepEqual(out.roles, [{ id: 'r1', code: 'PROGRAMMER', name: 'Programmer' }]);
  assert.equal(out.createdAt, '2026-01-01T10:00:00.000Z');
  assert.equal(out.updatedAt, '2026-01-02T11:00:00.000Z');
});

test('mapProjectRow: значения по умолчанию (status=active, docsPath=null, пустые stages/roles)', () => {
  const out = mapProjectRow({ id: 'u', code: 'C', name: 'N', root_path: null });
  assert.equal(out.status, 'active');
  assert.equal(out.docsPath, null);
  assert.equal(out.tasksPath, null);
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

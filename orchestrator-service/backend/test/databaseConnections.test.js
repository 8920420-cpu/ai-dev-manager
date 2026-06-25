import test from 'node:test';
import assert from 'node:assert/strict';
import {
  redactConnection,
  normalizeConnectionInput,
  resolveProjectDatabaseRef,
} from '../src/databaseConnections.js';

// --- redactConnection: секрет никогда не отдаётся ---------------------------

test('redactConnection: secret НЕ в ответе, hasSecret отражает наличие', () => {
  const out = redactConnection({
    id: 'c1', name: 'Main', dbms_type: 'postgres', host: 'h', port: 5432,
    database: 'db', db_user: 'u', ssl_mode: 'require', secret: 'p@ss',
  });
  assert.equal('secret' in out, false);
  assert.equal('password' in out, false);
  assert.equal(out.hasSecret, true);
  assert.equal(out.dbmsType, 'postgres');
  assert.equal(out.user, 'u');
  assert.equal(out.sslMode, 'require');
});

test('redactConnection: пустой secret → hasSecret=false, dbmsType по умолчанию', () => {
  assert.equal(redactConnection({ id: 'x', secret: '   ' }).hasSecret, false);
  assert.equal(redactConnection({ id: 'x' }).dbmsType, 'postgres');
});

// --- normalizeConnectionInput -----------------------------------------------

test('normalizeConnectionInput: пустой/отсутствующий password не пишет secret (сохранить старый)', () => {
  assert.equal('secret' in normalizeConnectionInput({ name: 'A' }), false);
  assert.equal('secret' in normalizeConnectionInput({ password: '' }, { partial: true }), false);
  assert.equal(normalizeConnectionInput({ password: 'p' }).secret, 'p');
});

test('normalizeConnectionInput: partial обновляет только переданные ключи', () => {
  const out = normalizeConnectionInput({ host: 'newhost' }, { partial: true });
  assert.deepEqual(Object.keys(out), ['host']);
});

test('normalizeConnectionInput: неподдерживаемый dbmsType отклоняется', () => {
  assert.throws(() => normalizeConnectionInput({ dbmsType: 'mysql' }), /unsupported_dbms/);
});

// --- resolveProjectDatabaseRef: правило выбора БД проекта --------------------

test('передан null/"" → проект без БД', () => {
  assert.equal(resolveProjectDatabaseRef(null, ['a', 'b']), null);
  assert.equal(resolveProjectDatabaseRef('', ['a']), null);
});

test('передан существующий id → он и выбирается', () => {
  assert.equal(resolveProjectDatabaseRef('b', ['a', 'b']), 'b');
});

test('передан неизвестный id → 422 project_database_unknown', () => {
  assert.throws(() => resolveProjectDatabaseRef('x', ['a', 'b']), /project_database_unknown/);
});

test('не передан + одно подключение → оно по умолчанию', () => {
  assert.equal(resolveProjectDatabaseRef(undefined, ['only']), 'only');
});

test('не передан + несколько → 422 project_database_selection_required', () => {
  assert.throws(() => resolveProjectDatabaseRef(undefined, ['a', 'b']), /project_database_selection_required/);
});

test('не передан + нет подключений → проект без БД', () => {
  assert.equal(resolveProjectDatabaseRef(undefined, []), null);
});

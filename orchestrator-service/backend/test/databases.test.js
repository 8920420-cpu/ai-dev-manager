import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listDatabases, PRIMARY_DB_ID } from '../src/databases.js';

const SETTINGS = {
  host: 'db.example',
  port: 6432,
  user: 'orch',
  password: 'secret',
  database: 'orchestrator_db',
  adminDatabase: 'postgres',
};

test('listDatabases: возвращает основную БД без пароля', async () => {
  const fakeStatus = async () => ({ connected: true, database: 'orchestrator_db', tables: 12 });
  const { databases } = await listDatabases(SETTINGS, fakeStatus);
  assert.equal(databases.length, 1);
  const db = databases[0];
  assert.equal(db.id, PRIMARY_DB_ID);
  assert.equal(db.kind, 'primary');
  assert.equal(db.host, 'db.example');
  assert.equal(db.port, 6432);
  assert.equal(db.database, 'orchestrator_db');
  assert.equal(db.user, 'orch');
  // Пароль НИКОГДА не покидает сервер — только флаг.
  assert.equal(db.hasPassword, true);
  assert.equal('password' in db, false);
  assert.deepEqual(db.status, { connected: true, tables: 12, error: null });
});

test('listDatabases: проброс ошибки статуса в карточку', async () => {
  const fakeStatus = async () => ({ connected: false, database: 'orchestrator_db', error: 'ECONNREFUSED' });
  const { databases } = await listDatabases({ ...SETTINGS, password: '' }, fakeStatus);
  const db = databases[0];
  assert.equal(db.hasPassword, false);
  assert.equal(db.status.connected, false);
  assert.equal(db.status.error, 'ECONNREFUSED');
  assert.equal(db.status.tables, null);
});

test('listDatabases: sslMode по умолчанию disable', async () => {
  const { databases } = await listDatabases(SETTINGS, async () => ({ connected: true, tables: 0 }));
  assert.equal(databases[0].sslMode, 'disable');
});

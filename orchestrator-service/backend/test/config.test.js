import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Изолируем файл настроек во временном каталоге ДО импорта config.js,
// чтобы тесты не зависели от реального config/db.settings.json и окружения.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'orch-config-'));
process.env.ORCHESTRATOR_SETTINGS_PATH = path.join(tmpDir, 'db.settings.json');
process.env.PGPASSWORD = 'secret-pass';

const { redactSettings, saveSettings, resolveSettings, loadSettings, parseConnectionString } =
  await import('../src/config.js');

test.after(() => rmSync(tmpDir, { recursive: true, force: true }));

test('redactSettings удаляет пароль и выставляет hasPassword', () => {
  const r = redactSettings({ host: 'h', password: 'p' });
  assert.equal(r.host, 'h');
  assert.equal('password' in r, false, 'пароль не должен попадать клиенту');
  assert.equal(r.hasPassword, true);
  assert.equal(redactSettings({ host: 'h', password: '' }).hasPassword, false);
});

test('пустой пароль в patch сохраняет существующий секрет', async () => {
  await saveSettings({ host: '10.0.0.1', password: 'real-secret' });
  const resolved = await resolveSettings({ host: '10.0.0.1', password: '' });
  assert.equal(resolved.password, 'real-secret', 'пустое поле не должно затирать пароль');
});

test('непустой пароль в patch перезаписывает секрет', async () => {
  await saveSettings({ password: 'real-secret' });
  const resolved = await resolveSettings({ password: 'changed' });
  assert.equal(resolved.password, 'changed');
});

test('сохранение без пароля не теряет ранее сохранённый секрет', async () => {
  await saveSettings({ password: 'keep-me' });
  const saved = await saveSettings({ host: 'other-host' });
  assert.equal(saved.password, 'keep-me');
  assert.equal(saved.host, 'other-host');
});

test('пароль из строки подключения применяется', async () => {
  const resolved = await resolveSettings({ url: 'postgresql://u:fromurl@h:5432/db' });
  assert.equal(resolved.password, 'fromurl');
  assert.equal(resolved.user, 'u');
});

test('loadSettings возвращает секрет серверу (внутреннее использование)', async () => {
  await saveSettings({ password: 'internal' });
  const s = await loadSettings();
  assert.equal(s.password, 'internal');
});

test('parseConnectionString отклоняет не-postgres URL', () => {
  assert.throws(() => parseConnectionString('mysql://u:p@h/db'));
});

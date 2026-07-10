import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Изолируем настройки, хранилище скриншотов и включаем API-токен ДО импорта
// server.js (значения считываются на этапе загрузки модулей). Токен включён нарочно:
// эндпоинты виджета должны работать МИМО него (same-origin, без Authorization).
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'orch-fb-'));
process.env.ORCHESTRATOR_SETTINGS_PATH = path.join(tmpDir, 'db.settings.json');
process.env.ORCHESTRATOR_API_TOKEN = 'test-token';
process.env.FEEDBACK_SCREENSHOT_DIR = path.join(tmpDir, 'shots');

const { createApp } = await import('../src/server.js');

test.after(() => rmSync(tmpDir, { recursive: true, force: true }));

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function startServer(t) {
  const server = createApp();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      t.after(() => new Promise((r) => server.close(r)));
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

test('POST /api/feedback/screenshot без API-токена → 200 и { id, url }; GET url отдаёт картинку', async (t) => {
  const base = await startServer(t);
  const up = await fetch(`${base}/api/feedback/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: PNG_DATA_URL }),
  });
  assert.equal(up.status, 200, 'загрузка скриншота открыта для same-origin (мимо API-токена)');
  const body = await up.json();
  assert.match(body.id, /^[0-9a-f]{32}$/);
  assert.equal(body.url, `/api/feedback/screenshot/${body.id}.png`);

  const get = await fetch(`${base}${body.url}`);
  assert.equal(get.status, 200);
  assert.match(get.headers.get('content-type') || '', /^image\/png/);
  const buf = new Uint8Array(await get.arrayBuffer());
  assert.ok(buf.length > 0);
});

test('GET /api/feedback/screenshot/:id для неизвестного id → 404 not_found', async (t) => {
  const base = await startServer(t);
  const res = await fetch(`${base}/api/feedback/screenshot/deadbeefdeadbeefdeadbeefdeadbeef.png`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'not_found');
});

test('POST /api/feedback размещён ДО isAuthorized (не 401 и уже не 404 not_found)', async (t) => {
  const base = await startServer(t);
  // Без БД приём падает на подключении (500), но НЕ на авторизации (401) и НЕ на
  // фолбэке 404 — это и доказывает, что маршрут добавлен перед isAuthorized и
  // исходная ошибка «Запрошенные данные не найдены» устранена.
  const res = await fetch(`${base}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ externalId: 'FB-HTTP', message: 'достаточно длинное сообщение', user: 'ivan', category: 'bug' }),
  });
  assert.notEqual(res.status, 401, 'эндпоинт открыт для same-origin');
  const body = await res.json().catch(() => ({}));
  assert.notEqual(body.error, 'not_found', 'запрос больше не падает в фолбэк 404 not_found');
});

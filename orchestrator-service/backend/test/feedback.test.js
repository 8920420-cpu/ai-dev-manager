import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acceptFeedback,
  resolveUiIntakeToken,
  __resetTokenCacheForTest,
  parseScreenshotDataUrl,
  saveScreenshot,
  readScreenshot,
  UI_INTEGRATION_NAME,
} from '../src/feedback.js';

// 1x1 прозрачный PNG (валидный data-URL для тестов скриншота).
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// --- resolveUiIntakeToken ---------------------------------------------------
test('resolveUiIntakeToken: берёт секрет из ORCHESTRATOR_UI_INTAKE_TOKEN', () => {
  const prev = process.env.ORCHESTRATOR_UI_INTAKE_TOKEN;
  process.env.ORCHESTRATOR_UI_INTAKE_TOKEN = 'itk_env_secret';
  __resetTokenCacheForTest();
  try {
    assert.equal(resolveUiIntakeToken(), 'itk_env_secret');
    assert.equal(resolveUiIntakeToken(), 'itk_env_secret'); // кэшируется
  } finally {
    if (prev === undefined) delete process.env.ORCHESTRATOR_UI_INTAKE_TOKEN;
    else process.env.ORCHESTRATOR_UI_INTAKE_TOKEN = prev;
    __resetTokenCacheForTest();
  }
});

test('resolveUiIntakeToken: без env → пер-процессный fallback-токен (itk_*)', () => {
  const prev = process.env.ORCHESTRATOR_UI_INTAKE_TOKEN;
  delete process.env.ORCHESTRATOR_UI_INTAKE_TOKEN;
  __resetTokenCacheForTest();
  try {
    const t = resolveUiIntakeToken();
    assert.match(t, /^itk_[0-9a-f]{48}$/);
    assert.equal(resolveUiIntakeToken(), t); // стабилен в пределах процесса
  } finally {
    if (prev !== undefined) process.env.ORCHESTRATOR_UI_INTAKE_TOKEN = prev;
    __resetTokenCacheForTest();
  }
});

// --- acceptFeedback (happy-path) --------------------------------------------
test('acceptFeedback: провижинит интеграцию и передаёт корректный вход в acceptIntakeReport', async () => {
  let ensuredToken = null;
  let capturedInput = null;
  const result = await acceptFeedback(
    { host: 'x' },
    {
      externalId: 'FB-1',
      message: 'Кнопка «Отправить» не работает на экране проверки',
      user: 'ivan',
      category: 'bug',
      service: 'orchestrator-ui',
      form: '/tasks',
      autocontext: { url: 'http://localhost:4186/tasks', jsErrors: ['TypeError'] },
      screenshotUrl: '/api/feedback/screenshot/abc.png',
    },
    {
      token: 'itk_test',
      ensureIntegration: async (t) => { ensuredToken = t; return { name: UI_INTEGRATION_NAME }; },
      acceptIntakeReport: async (s, input) => {
        capturedInput = input;
        return {
          accepted: true, duplicate: false, imported: true,
          taskId: 'task-1', reportNumber: 42, externalId: input.externalId,
          nextRole: 'TASK_INTAKE_OFFICER', toStatus: 'BACKLOG',
        };
      },
    },
  );

  // Интеграция провижинится тем же токеном, что уходит в приём.
  assert.equal(ensuredToken, 'itk_test');
  // service фиксируется сервером, токен подставлен, категория и контекст прокинуты.
  assert.equal(capturedInput.token, 'itk_test');
  assert.equal(capturedInput.service, UI_INTEGRATION_NAME);
  assert.equal(capturedInput.externalId, 'FB-1');
  assert.equal(capturedInput.user, 'ivan');
  assert.equal(capturedInput.category, 'bug');
  assert.equal(capturedInput.form, '/tasks');
  assert.equal(capturedInput.screenshotUrl, '/api/feedback/screenshot/abc.png');
  assert.deepEqual(capturedInput.autocontext.jsErrors, ['TypeError']);
  // Ответ приведён к контракту FeedbackResult.
  assert.deepEqual(result, {
    accepted: true, duplicate: false, reportNumber: 42, taskId: 'task-1', externalId: 'FB-1',
  });
});

test('acceptFeedback: service из тела игнорируется — всегда orchestrator-ui', async () => {
  let capturedInput = null;
  await acceptFeedback({}, { externalId: 'FB-2', message: 'msg', user: 'u', service: 'spoofed' }, {
    token: 't',
    ensureIntegration: async () => ({}),
    acceptIntakeReport: async (s, input) => { capturedInput = input; return { accepted: true, reportNumber: 1 }; },
  });
  assert.equal(capturedInput.service, UI_INTEGRATION_NAME);
});

// --- acceptFeedback (дубль по externalId) -----------------------------------
test('acceptFeedback: дубль по externalId → duplicate=true, тот же reportNumber', async () => {
  const result = await acceptFeedback({}, { externalId: 'FB-DUP', message: 'msg', user: 'u' }, {
    token: 't',
    ensureIntegration: async () => ({}),
    acceptIntakeReport: async () => ({
      accepted: true, duplicate: true, imported: false, taskId: 'task-dup', reportNumber: 7, externalId: 'FB-DUP',
    }),
  });
  assert.equal(result.duplicate, true);
  assert.equal(result.reportNumber, 7);
  assert.equal(result.taskId, 'task-dup');
  assert.equal(result.externalId, 'FB-DUP');
});

// --- acceptFeedback (интеграция выключена / отсутствует) --------------------
test('acceptFeedback: выключенная интеграция → пробрасывает integration_disabled', async () => {
  await assert.rejects(
    () => acceptFeedback({}, { externalId: 'FB-3', message: 'msg', user: 'u' }, {
      token: 't',
      ensureIntegration: async () => ({}),
      acceptIntakeReport: async () => { const e = new Error('integration_disabled'); e.statusCode = 403; throw e; },
    }),
    (e) => { assert.equal(e.statusCode, 403); assert.equal(e.message, 'integration_disabled'); return true; },
  );
});

test('acceptFeedback: провал провижининга интеграции пробрасывается (приём не идёт)', async () => {
  let accepted = false;
  await assert.rejects(
    () => acceptFeedback({}, { externalId: 'FB-4', message: 'msg', user: 'u' }, {
      token: 't',
      ensureIntegration: async () => { const e = new Error('token_required'); e.statusCode = 422; throw e; },
      acceptIntakeReport: async () => { accepted = true; return {}; },
    }),
    (e) => { assert.equal(e.statusCode, 422); return true; },
  );
  assert.equal(accepted, false, 'при провале провижининга приём обращения не выполняется');
});

// --- Скриншоты: разбор data-URL ---------------------------------------------
test('parseScreenshotDataUrl: валидный PNG → { ext, buffer }', () => {
  const { ext, buffer } = parseScreenshotDataUrl(PNG_DATA_URL);
  assert.equal(ext, 'png');
  assert.ok(buffer.length > 0);
});

test('parseScreenshotDataUrl: не data-URL → 422 screenshot_invalid', () => {
  assert.throws(() => parseScreenshotDataUrl('http://example/x.png'),
    (e) => { assert.equal(e.statusCode, 422); assert.equal(e.message, 'screenshot_invalid'); return true; });
});

test('parseScreenshotDataUrl: неподдерживаемый MIME (svg) → 415 screenshot_unsupported_type', () => {
  assert.throws(() => parseScreenshotDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='),
    (e) => { assert.equal(e.statusCode, 415); assert.equal(e.message, 'screenshot_unsupported_type'); return true; });
});

test('parseScreenshotDataUrl: превышение лимита размера → 413 screenshot_too_large', () => {
  assert.throws(() => parseScreenshotDataUrl(PNG_DATA_URL, { maxBytes: 1 }),
    (e) => { assert.equal(e.statusCode, 413); assert.equal(e.message, 'screenshot_too_large'); return true; });
});

// --- Скриншоты: сохранение и отдача ------------------------------------------
test('saveScreenshot + readScreenshot: круговой путь (по id и по id.ext)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-shot-'));
  try {
    const saved = await saveScreenshot(PNG_DATA_URL, { dir });
    assert.match(saved.id, /^[0-9a-f]{32}$/);
    assert.equal(saved.url, `/api/feedback/screenshot/${saved.id}.png`);

    const byId = await readScreenshot(saved.id, { dir });
    assert.equal(byId.mime, 'image/png');
    assert.ok(byId.buffer.length > 0);

    // GET по значению из url (id с расширением) отдаёт тот же файл.
    const byIdExt = await readScreenshot(`${saved.id}.png`, { dir });
    assert.deepEqual(byIdExt.buffer, byId.buffer);
    assert.equal(byIdExt.mime, 'image/png');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readScreenshot: неизвестный id → 404 not_found', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-shot-'));
  try {
    await assert.rejects(() => readScreenshot('deadbeefdeadbeef', { dir }),
      (e) => { assert.equal(e.statusCode, 404); assert.equal(e.message, 'not_found'); return true; });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readScreenshot: невалидный формат id (traversal) → 404 not_found', async () => {
  await assert.rejects(() => readScreenshot('../secret'),
    (e) => { assert.equal(e.statusCode, 404); return true; });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invokeConnector } from '../src/connectors.js';

// ORCHESTRATOR-P2.2: legacy-alias `input.prompt` удалён. Канонический контракт
// invoke — { system?, user?, isManual? }. Эти проверки отрабатывают до любого
// обращения к БД (валидация входа происходит раньше withClient), поэтому мок pg
// не требуется.

async function rejectStatus(input, expected = 422) {
  await assert.rejects(
    () => invokeConnector('any-id', input),
    (e) => {
      assert.equal(e.statusCode, expected, `ожидался HTTP ${expected}, получено ${e.statusCode}`);
      assert.equal(e.message, 'prompt_required');
      return true;
    },
  );
}

test('invokeConnector: legacy { prompt } без user/system отклоняется 422 (alias удалён)', async () => {
  await rejectStatus({ prompt: 'привет' });
});

test('invokeConnector: { prompt } больше не подставляется в user', async () => {
  // Раньше prompt служил источником user; теперь это поле игнорируется и при
  // отсутствии user/system запрос получает стабильную 422-ошибку.
  await rejectStatus({ user: '', prompt: 'непустой текст' });
});

test('invokeConnector: пустой payload отклоняется 422', async () => {
  await rejectStatus({});
});

test('invokeConnector: только пробелы в user/system отклоняются 422', async () => {
  await rejectStatus({ user: '   ', system: '  ' });
});

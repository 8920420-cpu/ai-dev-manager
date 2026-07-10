import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  invokeConnector,
  isDriverProvider,
  __setClientFactoryForTest,
} from '../src/connectors.js';

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

// ROLE-ENGINE-ROUTING-001: коннектор-«драйвер» (Codex / Claude Code) не имеет
// сетевого endpoint и access token. invokeConnector обязан перехватить такой
// провайдер сразу после чтения строки из БД и вернуть 422
// 'connector_driver_not_invocable', не уходя в llmInvoke с пустым
// endpoint/token. Сам guard живёт внутри withClient (требует БД), поэтому здесь
// проверяем предикат маршрутизации, на котором он держится.
test('isDriverProvider: codex/claude_code распознаются как драйверы (любой регистр)', () => {
  for (const p of ['codex', 'claude_code', 'CODEX', ' Claude_Code ']) {
    assert.equal(isDriverProvider(p), true, `ожидался драйвер для "${p}"`);
  }
});

test('isDriverProvider: сетевые AI-провайдеры драйверами не считаются', () => {
  for (const p of ['openai', 'deepseek', '', undefined, null]) {
    assert.equal(isDriverProvider(p), false, `не должен быть драйвером: "${p}"`);
  }
});

// Точные проверки по формулировке задачи: codex/claude_code → драйверы,
// deepseek/openai → нет.
test('isDriverProvider: codex и claude_code → true', () => {
  assert.equal(isDriverProvider('codex'), true);
  assert.equal(isDriverProvider('claude_code'), true);
});

test('isDriverProvider: deepseek и openai → false', () => {
  assert.equal(isDriverProvider('deepseek'), false);
  assert.equal(isDriverProvider('openai'), false);
});

// Поддельный pg-клиент: возвращает заданную строку коннектора на SELECT из
// connectors и фиксирует все запросы, чтобы проверить, что дальше INSERT/LLM
// дело не дошло. connect/end/on — пустышки (сеть/БД не задействуются).
function makeFakeClient(row, calls) {
  return {
    on() {},
    async connect() {},
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT/i.test(sql) && /FROM\s+connectors/i.test(sql)) {
        return { rowCount: 1, rows: [row] };
      }
      throw new Error(`неожиданный SQL в тесте: ${sql}`);
    },
    async end() {},
  };
}

function driverRow(provider = 'codex') {
  // Структура совпадает с CONNECTOR_COLUMNS (snake_case до rowToConnector).
  return {
    id: 'c-driver',
    name: 'Codex',
    provider,
    endpoint: '',
    access_token: '',
    model: '',
    consumer_service: '',
    priority: 100,
    is_enabled: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

// ROLE-ENGINE-ROUTING-001: когда строка коннектора имеет provider='codex'
// (драйвер), invokeConnector обязан вернуть 422 СРАЗУ после чтения строки из БД
// и НЕ уходить в llmInvoke. Подменяем pg-клиент через __setClientFactoryForTest,
// чтобы getRow вернул driver-строку без реальной БД, и убеждаемся, что
// единственный SQL — это чтение коннектора (никакого INSERT в prompt_exchanges).
test('invokeConnector: driver-коннектор (provider=codex) → 422 без LLM-вызова', async () => {
  const calls = [];
  __setClientFactoryForTest(() => makeFakeClient(driverRow('codex'), calls));
  try {
    await assert.rejects(
      () => invokeConnector('c-driver', { user: 'привет' }),
      (e) => {
        assert.equal(e.statusCode, 422, `ожидался HTTP 422, получено ${e.statusCode}`);
        assert.equal(e.message, 'connector_driver_not_invocable');
        return true;
      },
    );
    // Доказательство «вместо попытки LLM-вызова»: выполнен ровно один запрос —
    // SELECT коннектора. Запись обмена (INSERT) и llmInvoke не запускались.
    assert.equal(calls.length, 1, `ожидался один SQL-запрос, было ${calls.length}`);
    assert.match(calls[0].sql, /FROM\s+connectors/);
  } finally {
    __setClientFactoryForTest(null);
  }
});

// ROLE-ENGINE-ROUTING-001: список интеграций (таблица connectors, откуда читает
// /api/connectors и селектор «Интеграция (коннектор)» в карточке роли) обязан
// содержать Codex и Claude Code. Их заводит миграция 0036_driver_connectors.sql
// сидированием двух driver-строк. Проверяем содержимое миграции напрямую (без БД):
// обе записи присутствуют, привязаны к driver-провайдерам и накат идемпотентен.
test('миграция 0036: список интеграций получает Codex и Claude Code как driver-коннекторы', async () => {
  const sql = await readFile(
    new URL('../db/migrations/0036_driver_connectors.sql', import.meta.url),
    'utf8',
  );
  // Сидирование именно в таблицу интеграций.
  assert.match(sql, /INSERT\s+INTO\s+connectors/i, 'ожидался INSERT INTO connectors');
  // Обе интеграции присутствуют с правильными driver-провайдерами.
  assert.match(sql, /'Codex'\s*,\s*'codex'/, 'ожидался сид Codex → provider codex');
  assert.match(sql, /'Claude Code'\s*,\s*'claude_code'/, 'ожидался сид Claude Code → provider claude_code');
  // Провайдеры сидируемых строк — именно драйверы (а не сетевые AI-API).
  assert.equal(isDriverProvider('codex'), true);
  assert.equal(isDriverProvider('claude_code'), true);
  // Идемпотентность: повторный накат миграции не дублирует записи.
  assert.match(sql, /ON\s+CONFLICT[\s\S]*DO\s+NOTHING/i, 'ожидался ON CONFLICT ... DO NOTHING');
});

// claude_code — второй драйвер: то же поведение (422, без LLM-вызова).
test('invokeConnector: driver-коннектор (provider=claude_code) → 422 без LLM-вызова', async () => {
  const calls = [];
  __setClientFactoryForTest(() => makeFakeClient(driverRow('claude_code'), calls));
  try {
    await assert.rejects(
      () => invokeConnector('c-driver', { user: 'привет' }),
      (e) => {
        assert.equal(e.statusCode, 422);
        assert.equal(e.message, 'connector_driver_not_invocable');
        return true;
      },
    );
    assert.equal(calls.length, 1);
  } finally {
    __setClientFactoryForTest(null);
  }
});

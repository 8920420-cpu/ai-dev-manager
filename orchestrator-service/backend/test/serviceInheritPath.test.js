import test from 'node:test';
import assert from 'node:assert/strict';
import { getOrCreateService } from '../src/db.js';

// SERVICE-REPO-PATH-INHERIT-001 — при авто-создании сервиса с ПУСТЫМ repository_path
// наследуем путь от сервиса-сиблинга того же проекта с совпадающим НОРМАЛИЗОВАННЫМ
// кодом (lower, без -/_) и валидным путём. Мини-клиент pg отвечает по regex-правилам.
function fakeClient(rules) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const rule of rules) {
        if (rule.re.test(sql)) {
          const out = typeof rule.reply === 'function' ? rule.reply(params) : rule.reply;
          return out ?? { rows: [], rowCount: 0 };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// repository_path, с которым реально пошёл INSERT (4-й параметр).
function insertedRepoPath(c) {
  const ins = c.calls.find((x) => /INSERT INTO services/.test(x.sql));
  return ins ? ins.params[3] : undefined;
}

const NOT_FOUND = { re: /SELECT id FROM services/, reply: { rows: [], rowCount: 0 } };
const INSERT_OK = { re: /INSERT INTO services/, reply: { rows: [{ id: 'new-svc' }], rowCount: 1 } };

test('пустой путь + один сиблинг с валидным путём (PS-Torg-frontend ← PSTORG_FRONTEND) → наследует путь', async () => {
  const c = fakeClient([
    NOT_FOUND,
    { re: /SELECT DISTINCT repository_path/, reply: { rows: [{ repository_path: 'PS-Torg/Getway_DataHub/frontend' }], rowCount: 1 } },
    INSERT_OK,
  ]);
  const id = await getOrCreateService(c, 'p1', 'PS-Torg-frontend', null, null);
  assert.equal(id, 'new-svc');
  assert.equal(insertedRepoPath(c), 'PS-Torg/Getway_DataHub/frontend', 'путь унаследован от сиблинга');
});

test('явно переданный путь → сиблинг-запрос НЕ делается, путь как есть', async () => {
  const c = fakeClient([NOT_FOUND, INSERT_OK]);
  await getOrCreateService(c, 'p1', 'PS-Torg-frontend', null, 'PS-Torg/Getway_DataHub/frontend');
  assert.equal(insertedRepoPath(c), 'PS-Torg/Getway_DataHub/frontend');
  assert.equal(c.calls.some((x) => /SELECT DISTINCT repository_path/.test(x.sql)), false,
    'при непустом переданном пути наследование не запускается');
});

test('неоднозначность: сиблинги под одним норм-кодом дают РАЗНЫЕ пути → не угадываем, NULL', async () => {
  const c = fakeClient([
    NOT_FOUND,
    // DISTINCT вернул 2 строки — разные пути под одним нормализованным кодом.
    { re: /SELECT DISTINCT repository_path/, reply: { rows: [
      { repository_path: 'a/frontend' }, { repository_path: 'b/frontend' },
    ], rowCount: 2 } },
    INSERT_OK,
  ]);
  await getOrCreateService(c, 'p1', 'PS-Torg-frontend', null, null);
  assert.equal(insertedRepoPath(c), null, 'при неоднозначности путь остаётся NULL (штатный блок)');
});

test('нет сиблингов с путём (логический сервис INTEGRATION) → NULL, как и было', async () => {
  const c = fakeClient([
    NOT_FOUND,
    { re: /SELECT DISTINCT repository_path/, reply: { rows: [], rowCount: 0 } },
    INSERT_OK,
  ]);
  await getOrCreateService(c, 'p1', 'INTEGRATION', null, null);
  assert.equal(insertedRepoPath(c), null);
});

test('пустой код → null, БД не трогаем', async () => {
  const c = fakeClient([]);
  const id = await getOrCreateService(c, 'p1', '   ', null, null);
  assert.equal(id, null);
  assert.equal(c.calls.length, 0, 'пустой код не порождает запросов');
});

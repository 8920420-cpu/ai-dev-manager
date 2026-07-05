// TASK-PRIORITY-SCALE-001 — тесты миграций приоритетов задач. По образцу
// connectors.test.js: содержимое .sql проверяем напрямую (без БД). Здесь — что
// миграция 0047 действительно меняет ENUM → SMALLINT, делает backfill (оркестратор→0,
// остальные→2), ставит NOT NULL/DEFAULT 2/CHECK 0..3, индекс очередей и DROP TYPE;
// а 0048 добавляет поле priority в контракт и промт Приёмщика.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8');

test('0047: колонка priority переводится ENUM task_priority → SMALLINT', async () => {
  const sql = await read('0047_task_priority_scale.sql');
  // Смену типа делаем только пока колонка ещё ENUM (идемпотентность).
  assert.match(sql, /udt_name\s*=\s*'task_priority'/, 'смена типа под охраной «колонка ещё ENUM»');
  assert.match(sql, /ALTER TABLE tasks ALTER COLUMN priority DROP DEFAULT/, 'снимается старый DEFAULT');
  assert.match(sql, /ALTER COLUMN priority TYPE smallint/i, 'колонка становится SMALLINT');
});

test('0047: backfill — оркестратор → 0, остальные → 2', async () => {
  const sql = await read('0047_task_priority_scale.sql');
  // Все → 2 (в т.ч. project_id IS NULL).
  assert.match(sql, /UPDATE tasks SET priority = 2/, 'все задачи → обычный приоритет 2');
  // Оркестратор → 0 по code=PROJECT ИЛИ root_path LIKE ai-dev-manager.
  assert.match(sql, /UPDATE tasks t SET priority = 0/, 'задачи оркестратора → 0');
  assert.match(sql, /p\.code\s*=\s*'PROJECT'/, 'признак оркестратора по code=PROJECT');
  assert.match(sql, /root_path\s+LIKE\s+'%ai-dev-manager%'/, 'признак оркестратора по root_path');
});

test('0047: NOT NULL, DEFAULT 2, CHECK (0..3), индекс очередей, DROP TYPE', async () => {
  const sql = await read('0047_task_priority_scale.sql');
  assert.match(sql, /ALTER COLUMN priority SET NOT NULL/, 'NOT NULL');
  assert.match(sql, /ALTER COLUMN priority SET DEFAULT 2/, 'DEFAULT 2');
  assert.match(sql, /CHECK\s*\(priority BETWEEN 0 AND 3\)/, 'CHECK 0..3');
  assert.match(sql, /CREATE INDEX IF NOT EXISTS[\s\S]*ON tasks\(status, priority, created_at\)/,
    'индекс под выборки очередей (status, priority, created_at)');
  assert.match(sql, /DROP TYPE IF EXISTS task_priority/, 'неиспользуемый ENUM-тип удаляется');
});

test('0048: поле priority добавляется в контракт TASK_INTAKE_OFFICER', async () => {
  const sql = await read('0048_intake_officer_priority.sql');
  assert.match(sql, /INSERT INTO fields[\s\S]*'priority'/, 'ключ priority в справочнике fields');
  assert.match(sql, /INSERT INTO role_fields[\s\S]*'TASK_INTAKE_OFFICER'/, 'выходной контракт роли');
});

test('0048: промт Приёмщика описывает шкалу 1-3 и запрет 0 (форс сервера)', async () => {
  const sql = await read('0048_intake_officer_priority.sql');
  // Идемпотентный accumulate с guard-marker (как 0045).
  assert.match(sql, /INTAKE-OFFICER-PRIORITY-001/, 'guard-marker метка');
  assert.match(sql, /prompt NOT LIKE '%INTAKE-OFFICER-PRIORITY-001%'/, 'повторный накат не дублирует');
  // Правила расстановки по критичности.
  assert.match(sql, /blocker of many tasks|pipeline degradation/i, 'приоритет 1 — деградация/блокер');
  assert.match(sql, /default.*2|`2`/i, 'приоритет 2 — обычный (дефолт)');
  assert.match(sql, /cosmetics|documentation/i, 'приоритет 3 — косметика/доки');
  // 0 роль/клиент не ставит — форс сервера для оркестратора.
  assert.match(sql, /reserved for the orchestrator project/i, '0 зарезервирован за оркестратором (форс сервера)');
});

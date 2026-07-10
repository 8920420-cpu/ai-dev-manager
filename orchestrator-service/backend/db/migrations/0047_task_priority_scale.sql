-- =====================================================================
-- TASK-PRIORITY-SCALE-001 — приоритеты задач как SMALLINT (меньше = важнее).
--
-- Колонка tasks.priority была ENUM task_priority DEFAULT 'MEDIUM'. Переводим её
-- на числовую шкалу SMALLINT 0..3:
--   0 — ЗАРЕЗЕРВИРОВАН за проектом оркестратора (PROJECT / ai-dev-manager);
--       выставляется/форсится ТОЛЬКО сервером (клиент/роль его не ставит);
--   1 — максимальный пользовательский приоритет (деградация конвейера/блокер);
--   2 — обычный (дефолт);
--   3 — низкий (косметика/доки).
--
-- Backfill: задачи проекта оркестратора → 0; все остальные (в т.ч. project_id
-- IS NULL) → 2. Индекс под выборки очередей: (status, priority, created_at).
--
-- Идемпотентно: смену типа и backfill выполняем только пока колонка ещё ENUM;
-- CHECK/DEFAULT/индекс/DROP TYPE — под IF (NOT) EXISTS-охраной.
-- =====================================================================
BEGIN;

DO $mig$
BEGIN
  -- Меняем тип и делаем backfill только один раз — пока колонка ещё ENUM.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'tasks' AND column_name = 'priority'
       AND udt_name = 'task_priority'
  ) THEN
    -- 1. Снять DEFAULT ('MEDIUM'): он несовместим с новым типом.
    ALTER TABLE tasks ALTER COLUMN priority DROP DEFAULT;
    -- 2. Пересоздать колонку как SMALLINT. Значение при конверсии неважно — все
    --    строки перекрываются backfill'ом ниже (оркестратор→0, остальные→2).
    ALTER TABLE tasks ALTER COLUMN priority TYPE smallint USING 2;
    -- 3a. Backfill: все задачи → обычный приоритет 2 (в т.ч. project_id IS NULL).
    UPDATE tasks SET priority = 2;
    -- 3b. Backfill: задачи проекта оркестратора → 0 (важнее любого пользовательского).
    UPDATE tasks t SET priority = 0
      FROM projects p
     WHERE t.project_id = p.id
       AND (p.code = 'PROJECT' OR p.root_path LIKE '%ai-dev-manager%');
  END IF;
END
$mig$;

-- 4. NOT NULL + DEFAULT 2.
ALTER TABLE tasks ALTER COLUMN priority SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN priority SET DEFAULT 2;

-- 5. CHECK (priority BETWEEN 0 AND 3).
DO $chk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_priority_range'
  ) THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_priority_range CHECK (priority BETWEEN 0 AND 3);
  END IF;
END
$chk$;

-- 6. Индекс под выборки очередей: сортировка priority ASC, created_at ASC внутри
--    статуса (claim ролей, очередь программиста, feeder/scanner-мост).
CREATE INDEX IF NOT EXISTS idx_tasks_status_priority_created
    ON tasks(status, priority, created_at);

-- 7. Удаляем неиспользуемый ENUM-тип (колонка уже SMALLINT; иных пользователей нет).
DROP TYPE IF EXISTS task_priority;

COMMIT;

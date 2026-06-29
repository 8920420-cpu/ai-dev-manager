-- =====================================================================
-- TASK-ACCEPTANCE-001 — ручной приём (гейт «Проверка») задач, завершивших конвейер.
--
-- Зачем: задача, прошедшая все роли маршрута, переводится в DONE автоматически.
-- Раздел «Задачи» теперь делится на подразделы:
--   • «В работе»  — задачи на любой роли (status <> DONE);
--   • «Проверка»  — задачи DONE, ещё не принятые человеком (accepted_at IS NULL);
--   • «Выполнено» — задачи DONE, принятые человеком (accepted_at IS NOT NULL).
-- Приём («Принять») проставляет accepted_at; «Доработка» возвращает задачу на
-- выбранный этап (moveTask) и снимает accepted_at.
--
-- Семантику DONE НЕ меняем: роллап эпиков/подзадач, restart-stuck и т.п. работают
-- по статусу как раньше — accepted_at лишь отделяет «принятые» от «на проверке».
--
-- Read-only аудит перед миграцией:
--   tasks.accepted_at — колонки нет, добавляется (nullable timestamptz);
--   существующие DONE-задачи помечаем принятыми (бэкфилл), чтобы они не висели
--   в «Проверке», а сразу попали в «Выполнено».
-- Идемпотентно: ADD COLUMN IF NOT EXISTS + бэкфилл только для accepted_at IS NULL.
-- =====================================================================
BEGIN;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
COMMENT ON COLUMN tasks.accepted_at IS
  'TASK-ACCEPTANCE-001: момент ручного приёма задачи (гейт «Проверка»). '
  'NULL для задач DONE, ожидающих приёма; NOT NULL — принятые («Выполнено»). '
  'Для не-DONE задач не используется.';

-- Бэкфилл: всё, что уже DONE на момент миграции, считаем принятым, чтобы
-- историю не выгружало в очередь «Проверка». Берём updated_at (когда задача
-- завершилась), с откатом на created_at/now() при отсутствии метки.
UPDATE tasks
   SET accepted_at = COALESCE(updated_at, created_at, now())
 WHERE status = 'DONE' AND accepted_at IS NULL;

-- Очередь «Проверка» = DONE без accepted_at: частичный индекс ускоряет выборку.
CREATE INDEX IF NOT EXISTS idx_tasks_acceptance_pending
    ON tasks(updated_at) WHERE status = 'DONE' AND accepted_at IS NULL;

COMMIT;

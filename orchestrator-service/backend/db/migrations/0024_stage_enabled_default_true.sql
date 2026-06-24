-- =====================================================================
-- LEGACY-STAGE-DEFAULTS-002 — вернуть совместимость «отсутствует = включён».
-- Откатывает 0013_stage_enabled_explicit.sql: возвращает DEFAULT true на
-- project_stages.enabled. Требование задачи (контракт включения этапов):
-- «старые записи без поля читаются как включённые; по умолчанию true».
-- Колонка остаётся NOT NULL; INSERT без enabled теперь снова берёт true,
-- а контракт чтения трактует отсутствие/любое не-false значение как включён.
--
-- Только метаданные колонки (SET DEFAULT) — данные строк НЕ изменяются.
-- Идемпотентно: повторный SET DEFAULT безопасен (перезапись того же default).
-- Rollback: ALTER TABLE project_stages ALTER COLUMN enabled DROP DEFAULT;
-- =====================================================================
BEGIN;

ALTER TABLE project_stages ALTER COLUMN enabled SET DEFAULT true;

COMMENT ON COLUMN project_stages.enabled IS
  'Активность этапа. false = этап пропускается исполнителем; этап остаётся в '
  'проекте и порядке. Совместимость: отсутствие поля/значение кроме явного '
  'false трактуется как включён (DEFAULT true, LEGACY-STAGE-DEFAULTS-002).';

COMMIT;

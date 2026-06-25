-- =====================================================================
-- LEGACY-STAGE-DEFAULTS-001 (ORCHESTRATOR-P2.3) — сделать enabled явным.
-- Убираем БД-эквивалент совместимости «отсутствует = true»: снимаем DEFAULT
-- на project_stages.enabled. Колонка остаётся NOT NULL, поэтому каждый INSERT
-- обязан передавать enabled явно (saveStagesRows уже всегда передаёт boolean).
--
-- Read-only аудит перед миграцией (2026-06-22):
--   project_stages: 22 строки; enabled IS NULL = 0; распределение: 22×true.
-- Данные строк НЕ изменяются — это метаданные колонки (DROP DEFAULT).
--
-- Rollback: ALTER TABLE project_stages ALTER COLUMN enabled SET DEFAULT true;
-- Идемпотентно: повторный DROP DEFAULT безопасен (no-op при отсутствии default).
-- =====================================================================
BEGIN;

ALTER TABLE project_stages ALTER COLUMN enabled DROP DEFAULT;

COMMENT ON COLUMN project_stages.enabled IS
  'Обязательный явный boolean. false = этап пропускается исполнителем; этап '
  'остаётся в проекте и порядке. Совместимость «отсутствует = true» удалена '
  '(ORCHESTRATOR-P2.3): API и БД требуют явного enabled.';

COMMIT;

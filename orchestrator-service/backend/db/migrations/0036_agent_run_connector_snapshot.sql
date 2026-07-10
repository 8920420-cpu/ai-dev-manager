-- =====================================================================
-- ROLE-ENGINE-ROUTING-002 — снимок коннектора в agent_runs.
--
-- Зачем: коннекторы (provider/model/driver) со временем переименовывают,
-- перенастраивают и удаляют. Чтобы исторические прогоны не теряли смысл и
-- агрегацию «токены/стоимость по провайдеру и модели за день» можно было
-- строить даже после изменения коннектора, фиксируем неизменяемый снимок
-- выбранного коннектора прямо в строке прогона.
--
-- Read-only аудит перед миграцией:
--   agent_runs (0001_init) — добавляемых колонок ещё нет, добавляются nullable:
--     snapshot_connector_id  (FK connectors.id) — колонки нет;
--     snapshot_provider      (text)             — колонки нет;
--     snapshot_model         (text)             — колонки нет;
--     snapshot_driver_type   (text)             — колонки нет;
--   started_at (0001_init) — timestamptz, существует, НЕ трогаем;
--   connectors.id (0004_connectors) — uuid PK, существует.
--   Существующие строки agent_runs остаются с NULL в новых полях.
-- Идемпотентно: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- =====================================================================
BEGIN;

-- Ссылка на коннектор-источник снимка. ON DELETE SET NULL: удаление коннектора
-- не должно ронять историю прогонов — текстовые snapshot_*-поля сохраняют, чем
-- именно исполнялся прогон, даже когда сам коннектор уже удалён.
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS snapshot_connector_id uuid REFERENCES connectors(id) ON DELETE SET NULL;
COMMENT ON COLUMN agent_runs.snapshot_connector_id IS
  'ROLE-ENGINE-ROUTING-002: коннектор, которым исполнялся прогон (снимок на момент '
  'запуска). NULL для исторических строк и после удаления коннектора.';

-- Неизменяемый снимок провайдера на момент запуска (codex / claude_code / deepseek / ...).
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS snapshot_provider text;
COMMENT ON COLUMN agent_runs.snapshot_provider IS
  'ROLE-ENGINE-ROUTING-002: снимок connectors.provider на момент запуска прогона.';

-- Неизменяемый снимок модели на момент запуска.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS snapshot_model text;
COMMENT ON COLUMN agent_runs.snapshot_model IS
  'ROLE-ENGINE-ROUTING-002: снимок connectors.model на момент запуска прогона.';

-- Тип драйвера: разделяет хостовые движки (driver) и сетевые AI-API (api и т.п.).
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS snapshot_driver_type text;
COMMENT ON COLUMN agent_runs.snapshot_driver_type IS
  'ROLE-ENGINE-ROUTING-002: снимок типа драйвера коннектора (driver/api) на момент запуска.';

-- Индекс под агрегацию «по дню × провайдер × модель».
-- started_at — timestamptz; двухаргументный date_trunc по timestamptz лишь STABLE
-- и в индексе по выражению недопустим. Берём date_trunc по timestamp в фиксированной
-- зоне UTC ((started_at AT TIME ZONE 'UTC')) — выражение IMMUTABLE и индексируемо.
-- Запросы агрегации должны использовать ровно это выражение, чтобы попасть в индекс.
CREATE INDEX IF NOT EXISTS idx_agent_runs_day_provider_model
  ON agent_runs (
    date_trunc('day', started_at AT TIME ZONE 'UTC'),
    snapshot_provider,
    snapshot_model
  );

COMMIT;

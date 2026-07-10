-- =====================================================================
-- OBSERVABILITY-REASONING-001 — пофазные KPI прогона роли в agent_runs.
--
-- Зачем: рассуждающие роли (Architect/Decomposer и пр.) исполняются внешним
-- движком (Claude Code/Codex). Раньше прогон измерялся одним durationMs, токены
-- не сохранялись (колонки token_input/token_output/cost были, но всегда = 0), а
-- по логу нельзя было отличить «думает и не успевает» от «висит и ничего не
-- делает». Теперь раннер шлёт пофазные метрики в сдаче (reasoning-completed), а
-- оркестратор пишет их сюда — для «Монитора производительности» (per-role KPI:
-- токены, средний холодный старт) и для разбора инцидентов.
--
-- Read-only аудит перед миграцией:
--   agent_runs.cold_start_ms — колонки нет, добавляется (nullable int);
--   agent_runs.turns         — колонки нет, добавляется (nullable int);
--   agent_runs.outcome       — колонки нет, добавляется (nullable text);
--   token_input/token_output/cost уже существуют (0001_init) — НЕ трогаем.
-- Идемпотентно: ADD COLUMN IF NOT EXISTS.
-- =====================================================================
BEGIN;

-- Длительность холодного старта движка (вызов агента → первый признак жизни SDK).
-- Аномально большие значения (см. ~21с у Claude Code) видны в KPI и алертах раннера.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS cold_start_ms integer;
COMMENT ON COLUMN agent_runs.cold_start_ms IS
  'OBSERVABILITY-REASONING-001: мс холодного старта движка до первого сообщения SDK '
  '(спавн + авторизация + hooks). NULL для in-process ролей без отдельной фазы старта.';

-- Число ходов агента (assistant-сообщений) — глубина tool-loop рассуждения.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS turns integer;
COMMENT ON COLUMN agent_runs.turns IS
  'OBSERVABILITY-REASONING-001: число ходов агента (assistant-сообщений) за прогон.';

-- Классифицированный исход прогона для KPI/диагностики: success | working_slow |
-- stuck_no_response | coldstart_failed | stalled_midway | failed:* | threw | empty_output.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS outcome text;
COMMENT ON COLUMN agent_runs.outcome IS
  'OBSERVABILITY-REASONING-001: классифицированный исход прогона (различает '
  '«думает и не успевает» working_slow от «висит» stuck_no_response/coldstart_failed).';

COMMIT;

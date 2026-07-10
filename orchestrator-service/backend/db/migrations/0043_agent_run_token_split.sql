-- =====================================================================
-- TOKEN-SPLIT-001 — разбивка ВХОДЯЩИХ токенов прогона на составляющие.
--
-- Зачем: agent_runs.token_input хранит СУММУ input + cache_creation + cache_read
-- (см. claudeReasoningAgent.extractUsage). В агентном tool-loop модель на КАЖДОМ
-- ходу перечитывает весь растущий диалог из кэша, поэтому cache_read накапливается
-- и раздувает «входящие токены»: у Архитектора ~95% «входа» — это дешёвый cache_read
-- (биллинг ~10% цены), а не свежий ввод. Из одного числа этого не видно.
--
-- Решение: НЕ меняем смысл token_input (остаётся полной суммой — историю и
-- существующие агрегаты не ломаем), а добавляем ДЕТАЛИЗАЦИЮ: сколько из входа было
-- записью в кэш (cache_creation) и чтением из кэша (cache_read). Свежий (uncached)
-- ввод считается как token_input − cache_read − cache_creation. Так «Монитор»
-- показывает честное деление, а старые запросы SUM(token_input) остаются верны.
--
-- Read-only аудит перед миграцией:
--   agent_runs.token_cache_read     — колонки нет, добавляется (nullable bigint);
--   agent_runs.token_cache_creation — колонки нет, добавляется (nullable bigint);
--   token_input/token_output/cost (0001_init) — НЕ трогаем (token_input = сумма).
-- NULL = разбивка неизвестна (исторические прогоны до этой миграции, а также
-- движки без prompt-кэша: codex токены не шлёт, DeepSeek — без cache-полей).
-- Идемпотентно: ADD COLUMN IF NOT EXISTS.
-- =====================================================================
BEGIN;

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS token_cache_read bigint;
COMMENT ON COLUMN agent_runs.token_cache_read IS
  'TOKEN-SPLIT-001: часть token_input, прочитанная из prompt-кэша (billed ~10%). '
  'Накапливается по ходам tool-loop. NULL — разбивка неизвестна (историч./codex/deepseek).';

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS token_cache_creation bigint;
COMMENT ON COLUMN agent_runs.token_cache_creation IS
  'TOKEN-SPLIT-001: часть token_input, записанная в prompt-кэш (billed ~125%). '
  'Свежий (uncached) ввод = token_input − token_cache_read − token_cache_creation.';

COMMIT;

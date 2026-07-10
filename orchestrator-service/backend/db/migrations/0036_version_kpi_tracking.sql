-- =====================================================================
-- VERSION-KPI-TRACKING-001 — атрибуция KPI прогона к версии кода и промта.
--
-- Зачем: чтобы отвечать на вопрос «поправили код/промт — как изменились
-- показатели роли?». Раньше agent_runs знал ЧТО намерил (токены/время/ходы),
-- но не ЧЕМ это намерено: какой версией промта роли и какой ревизией кода
-- раннера. Без этих «меток измерения» дельты KPI не к чему привязать.
--
-- Вводим три оси сравнения на прогон + историю промтов + журнал меток:
--   1) agent_runs.prompt_version — версия промта роли (ссылка на prompts.version),
--      штампуется при захвате (composeRoleSystemPrompt читает активный промт);
--   2) agent_runs.code_version   — git-SHA раннера на момент прогона (+флаг dirty),
--      для программиста это версионирует и его промт (он в коде, не в БД);
--   3) agent_runs.model          — фактически использованная модель (одинаковый
--      код+промт на другой модели = другой KPI; без этой оси сравнения врут).
--   4) prompts.*                 — таблица версий промтов УЖЕ есть (0001_init), но
--      кодом не используется: живой промт берётся из roles.prompt. Подключаем её
--      (label/content_hash/author) и сидируем version=1 из текущего roles.prompt.
--   5) kpi_markers               — журнал событий-меток (правка промта/деплой) для
--      вертикальных линий на графиках KPI.
--
-- Read-only аудит перед миграцией:
--   agent_runs.prompt_version/code_version/model — колонок нет, добавляются (nullable);
--   prompts (role_id, version, prompt_text, is_active, created_at) — есть (0001_init),
--     добавляем label/content_hash/author; данных в проде нет (таблица не писалась);
--   kpi_markers — таблицы нет, создаётся.
-- Идемпотентно: ADD COLUMN/TABLE IF NOT EXISTS, сид через NOT EXISTS-гард.
-- =====================================================================
BEGIN;

-- 1) Метки версии на прогоне роли.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS prompt_version integer;
COMMENT ON COLUMN agent_runs.prompt_version IS
  'VERSION-KPI-TRACKING-001: версия промта роли (prompts.version) на момент захвата. '
  'NULL для ролей без промта в БД (например, программист — его промт в коде).';

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS code_version text;
COMMENT ON COLUMN agent_runs.code_version IS
  'VERSION-KPI-TRACKING-001: git-SHA раннера на момент прогона (короткий, +"-dirty" '
  'при незакоммиченном дереве). Версионирует код-исполнитель и промт-в-коде.';

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS model text;
COMMENT ON COLUMN agent_runs.model IS
  'VERSION-KPI-TRACKING-001: фактически использованная модель прогона (ось сравнения '
  'KPI; одинаковый код+промт на другой модели даёт другие время/токены).';

-- Индексы под группировку KPI по версиям (versions-эндпоинт) за окно времени.
CREATE INDEX IF NOT EXISTS idx_agent_runs_role_started ON agent_runs(role_id, started_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_prompt_version ON agent_runs(prompt_version);

-- 2) Подключаем существующую таблицу версий промтов.
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS label text;
COMMENT ON COLUMN prompts.label IS
  'VERSION-KPI-TRACKING-001: человекочитаемая метка версии промта («ужал task-review»).';

ALTER TABLE prompts ADD COLUMN IF NOT EXISTS content_hash text;
COMMENT ON COLUMN prompts.content_hash IS
  'VERSION-KPI-TRACKING-001: sha256 текста промта — дедуп: сохранение без изменения '
  'текста не плодит новую версию.';

ALTER TABLE prompts ADD COLUMN IF NOT EXISTS author text;
COMMENT ON COLUMN prompts.author IS
  'VERSION-KPI-TRACKING-001: кто зафиксировал версию (опционально, для аудита).';

-- Быстрый поиск версии по хешу при дедупе.
CREATE INDEX IF NOT EXISTS idx_prompts_role_hash ON prompts(role_id, content_hash);

-- Сид baseline (version=1) из текущего roles.prompt для ролей БЕЗ версий. Это
-- «нулевая точка отсчёта»: последующая правка промта роли создаст version=2.
-- content_hash тут — «сырой» sha256 (справочно); дедуп в приложении сравнивает по
-- prompt_text активной версии, поэтому от этого значения не зависит.
INSERT INTO prompts (role_id, version, prompt_text, is_active, content_hash, label)
SELECT r.id, 1, r.prompt, true, encode(digest(r.prompt, 'sha256'), 'hex'), 'baseline'
  FROM roles r
 WHERE r.prompt IS NOT NULL AND btrim(r.prompt) <> ''
   AND NOT EXISTS (SELECT 1 FROM prompts p WHERE p.role_id = r.id);

-- Синхронизация существующих АКТИВНЫХ версий-заглушек с реальным промтом роли
-- (одобрено пользователем). В prompts от прежнего сида (0001_seed) лежали короткие
-- заглушки, не совпадающие с roles.prompt, который реально исполняется. Приводим
-- активную версию к фактическому тексту, чтобы prompt_version указывал на правду.
-- Затрагивает ТОЛЬКО строки, где текст реально отличается (идемпотентно).
UPDATE prompts p
   SET prompt_text = r.prompt,
       content_hash = encode(digest(r.prompt, 'sha256'), 'hex'),
       label = COALESCE(p.label, 'baseline (synced)')
  FROM roles r
 WHERE p.role_id = r.id
   AND p.is_active = true
   AND r.prompt IS NOT NULL AND btrim(r.prompt) <> ''
   AND p.prompt_text IS DISTINCT FROM r.prompt;

-- 3) Журнал меток KPI (правка промта / деплой / ручная отметка).
CREATE TABLE IF NOT EXISTS kpi_markers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id     uuid REFERENCES roles(id) ON DELETE SET NULL,
    marker_type text NOT NULL,                    -- prompt_version | deploy | manual
    ref         text,                             -- версия промта / git-SHA / произвольное
    description text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE kpi_markers IS
  'VERSION-KPI-TRACKING-001: события-метки на оси времени (правка промта/деплой) — '
  'вертикальные линии на графиках KPI для привязки скачков к причине.';
CREATE INDEX IF NOT EXISTS idx_kpi_markers_created ON kpi_markers(created_at);
CREATE INDEX IF NOT EXISTS idx_kpi_markers_role ON kpi_markers(role_id, created_at);

COMMIT;

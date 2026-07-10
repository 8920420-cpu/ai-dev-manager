-- =====================================================================
-- FORK-JOIN-001 (Phase 2) — модель данных блок-схемы: типы узлов и рёбра.
-- Идемпотентная миграция (повторный запуск безопасен).
-- =====================================================================
-- Аддитивно поверх линейной модели этапов. Узел схемы — это этап (stage) ИЛИ
-- управляющий узел: fork (разделить), join (объединить), condition (условие).
-- Рёбра графа хранятся отдельно и ссылаются на узлы по СТАБИЛЬНОМУ ключу
-- stage_key (а не по строковому PK), который переносится из глобальной схемы в
-- project_stages при материализации — поэтому рёбра проекта совпадают с
-- глобальными по ключам без позиционного маппинга.
-- =====================================================================

BEGIN;

-- 1. Тип узла. По умолчанию 'stage' — все существующие строки остаются этапами,
--    линейный резолвер маршрута их видит без изменений.
ALTER TABLE global_stages  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'stage';
ALTER TABLE project_stages ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'stage';

-- 2. Стабильный ключ узла (для ссылок рёбер, переживает реордер и материализацию).
ALTER TABLE global_stages  ADD COLUMN IF NOT EXISTS stage_key uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE project_stages ADD COLUMN IF NOT EXISTS stage_key uuid;
UPDATE project_stages SET stage_key = gen_random_uuid() WHERE stage_key IS NULL;

-- 3. Явная пара fork→join (на узле fork): какой join снимает его барьер.
ALTER TABLE global_stages  ADD COLUMN IF NOT EXISTS join_key uuid;
ALTER TABLE project_stages ADD COLUMN IF NOT EXISTS join_key uuid;

-- 4. Рёбра глобальной схемы (слой авторинга).
CREATE TABLE IF NOT EXISTS global_stage_edges (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_key   uuid NOT NULL,            -- ссылается на global_stages.stage_key
    to_key     uuid NOT NULL,
    -- Для узла condition: метка ветки (исход), по которой выбирается это ребро.
    -- NULL — безусловный переход (обычная связь / ветка fork).
    condition  text,
    position   int  NOT NULL DEFAULT 0,  -- порядок исходящих рёбер
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_global_stage_edges_from ON global_stage_edges(from_key);

-- 5. Материализованные рёбра проекта (рантайм-слой; ключи совпадают с глобальными).
CREATE TABLE IF NOT EXISTS project_stage_edges (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    from_key   uuid NOT NULL,
    to_key     uuid NOT NULL,
    condition  text,
    position   int  NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_project_stage_edges_proj ON project_stage_edges(project_id);
CREATE INDEX IF NOT EXISTS idx_project_stage_edges_from ON project_stage_edges(project_id, from_key);

-- 6. Синтетические gate-роли узлов fork/join. НЕ входят в LLM/HOST-роли — runner
--    их не клеймит; ими владеют подметатели advanceForkNodes/advanceJoinNodes.
--    hidden=true: они не показываются как обычные роли пайплайна в редакторе ролей.
INSERT INTO roles (code, name, hidden)
VALUES ('FORK_GATE', 'Разделение (fork)', true),
       ('JOIN_GATE', 'Объединение (join)', true)
ON CONFLICT (code) DO NOTHING;

COMMIT;

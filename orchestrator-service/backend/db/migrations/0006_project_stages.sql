-- =====================================================================
-- PIPELINE-STAGE-CONFIG-001 — серверное хранение этапов пайплайна проекта.
-- Идемпотентная миграция (повторный запуск безопасен).
-- =====================================================================
-- Контракт этапа (см. tasks/orchestrator-service.md → P0.1):
--   * enabled  — отключённый этап НЕ удаляется и НЕ меняет позицию;
--   * scanner.watchDirectory (watch_directory) — нормализованный абсолютный
--     путь; обязателен только для ВКЛЮЧЁННОГО этапа с ролью кода SCANNER;
--   * порядок этапов хранится в position (0..N), сохраняется при отключении.
-- Признак Scanner — ВСЕГДА код роли SCANNER, не отображаемое имя этапа.
-- =====================================================================

BEGIN;

-- Этапы пайплайна конкретного проекта (упорядоченный список).
CREATE TABLE IF NOT EXISTS project_stages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    position        int  NOT NULL,
    name            text NOT NULL,
    enabled         boolean NOT NULL DEFAULT true,
    -- Абсолютный путь к наблюдаемой папке (только для Scanner-этапа). Пустая
    -- строка не считается значением — храним NULL, чтобы отличать «нет папки».
    watch_directory text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, position)
);
COMMENT ON TABLE project_stages IS
  'Этапы пайплайна проекта: порядок, активность (enabled), папка Scanner.';
COMMENT ON COLUMN project_stages.enabled IS
  'false = этап будет пропущен исполнителем; этап остаётся в проекте и порядке.';
COMMENT ON COLUMN project_stages.watch_directory IS
  'Абсолютный путь Scanner. Существование каталога проверяет scanner-service.';

-- Роли, назначенные этапу (одна или несколько). Код роли SCANNER —
-- единственный признак Scanner-этапа.
CREATE TABLE IF NOT EXISTS project_stage_roles (
    stage_id uuid NOT NULL REFERENCES project_stages(id) ON DELETE CASCADE,
    role_id  uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    position int  NOT NULL DEFAULT 0,
    PRIMARY KEY (stage_id, role_id)
);
COMMENT ON TABLE project_stage_roles IS
  'Назначение ролей этапу пайплайна (M:N). Scanner определяется кодом роли SCANNER.';

CREATE INDEX IF NOT EXISTS idx_project_stages_project_id ON project_stages(project_id);
CREATE INDEX IF NOT EXISTS idx_project_stage_roles_role_id ON project_stage_roles(role_id);

-- Поддержка updated_at (функция trg_set_updated_at создана в 0001_init).
DROP TRIGGER IF EXISTS project_stages_set_updated_at ON project_stages;
CREATE TRIGGER project_stages_set_updated_at
    BEFORE UPDATE ON project_stages
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

COMMIT;

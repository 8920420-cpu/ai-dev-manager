-- =====================================================================
-- SCANNER-INTAKE-001 — импорт задач из файловой очереди tasks/*.md.
-- external_id хранит исходный идентификатор из frontmatter задачи
-- (например INTEGRATION-P1.5); первичный ключ задачи остаётся UUID.
-- Уникальность (project_id, external_id) обеспечивает идемпотентность:
-- повторный импорт того же файла не создаёт дубль задачи.
-- Идемпотентная миграция (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
-- =====================================================================
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS external_id text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_project_external_id
    ON tasks(project_id, external_id) WHERE external_id IS NOT NULL;

COMMENT ON COLUMN tasks.external_id IS
    'Внешний id задачи из файловой очереди (frontmatter tasks/*.md); идемпотентность импорта.';

-- =====================================================================
-- Привязка проекта к папке: projects.root_path.
-- Папка проекта — стабильный ключ связи локального проекта (frontend) с
-- проектом в orchestrator_db. Идемпотентная миграция.
-- =====================================================================
BEGIN;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS root_path text;
COMMENT ON COLUMN projects.root_path IS
  'Абсолютный путь к папке проекта. Ключ привязки локального проекта к БД.';

-- Одна папка = один проект. NULL допускает несколько (старые/seed-проекты).
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_root_path
    ON projects(root_path) WHERE root_path IS NOT NULL;

COMMIT;

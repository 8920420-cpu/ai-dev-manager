-- CODEBASE-MEMORY-PG-001: persistent Codebase Memory documents in Postgres.
-- The npm codebase-memory package writes markdown files. This table mirrors
-- those files into orchestrator_db so orchestrator roles can use one shared
-- Postgres-backed source without depending on local agent worktrees.

BEGIN;

CREATE TABLE IF NOT EXISTS codebase_memory_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  doc_key     text NOT NULL,
  title       text NOT NULL,
  file_path   text NOT NULL,
  content     text NOT NULL,
  checksum    text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, doc_key)
);

CREATE INDEX IF NOT EXISTS idx_codebase_memory_documents_project
  ON codebase_memory_documents(project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_codebase_memory_documents_metadata_gin
  ON codebase_memory_documents USING gin(metadata);

COMMENT ON TABLE codebase_memory_documents IS
  'Postgres-backed mirror of codebase-memory markdown files (.claude/rules, CLAUDE.md, CONVENTIONS.md).';

COMMENT ON COLUMN codebase_memory_documents.doc_key IS
  'Stable key: claude, architecture, stack, modules, models, api, conventions, gotchas, changelog, conventions_doc.';

DROP TRIGGER IF EXISTS trg_codebase_memory_documents_updated_at ON codebase_memory_documents;
CREATE TRIGGER trg_codebase_memory_documents_updated_at
  BEFORE UPDATE ON codebase_memory_documents
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

COMMIT;

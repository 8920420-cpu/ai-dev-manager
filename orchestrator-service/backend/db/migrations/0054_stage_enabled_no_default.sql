-- STAGE-ENABLED-STRICT-001: remove the legacy "missing enabled means true" DB fallback.
-- Existing rows are preserved; API writes already pass explicit true/false.

ALTER TABLE project_stages
  ALTER COLUMN enabled DROP DEFAULT;

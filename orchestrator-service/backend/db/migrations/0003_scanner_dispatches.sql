BEGIN;

CREATE TABLE IF NOT EXISTS scanner_dispatches (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id         uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    source_document text NOT NULL,
    completion_key  text NOT NULL,
    payload_json    jsonb NOT NULL,
    received_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (task_id, completion_key)
);

COMMENT ON TABLE scanner_dispatches IS
  'Идемпотентный журнал завершений из файлового Scanner bridge.';

CREATE INDEX IF NOT EXISTS idx_scanner_dispatches_task_id
    ON scanner_dispatches(task_id);

COMMIT;

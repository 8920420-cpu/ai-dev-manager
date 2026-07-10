-- ORCHESTRATOR-TOGGLE-001 — runtime-переключатель выполнения сценария.
BEGIN;

INSERT INTO app_settings (key, value)
VALUES ('orchestrator_enabled', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;

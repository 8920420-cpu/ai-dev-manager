-- =====================================================================
-- PIPELINE-NON-AI-EXECUTOR-001 (ORCHESTRATOR-P1.3) — PIPELINE_SERVICE как
-- не-AI исполнитель. Этап Pipeline выполняет pipeline-runner/host worker, а не
-- LLM, поэтому роль PIPELINE_SERVICE не должна требовать AI-интеграции.
-- Идемпотентная миграция. ВНИМАНИЕ: изменяет существующие данные agents —
-- применять только после отдельного подтверждения пользователя (правила
-- корневого TASKS.md и политики БД).
-- =====================================================================
BEGIN;

-- Локальный исполнитель роли PIPELINE_SERVICE (provider 'local', не LLM).
INSERT INTO agents (code, name, provider, model, role_id, is_active)
SELECT 'local_pipeline', 'Local Pipeline Runner', 'local', 'pipeline-runner', r.id, true
FROM roles r
WHERE r.code = 'PIPELINE_SERVICE'
ON CONFLICT (code) DO UPDATE SET
    provider = 'local',
    model = 'pipeline-runner',
    role_id = EXCLUDED.role_id,
    is_active = true;

-- Снять прежнего AI-агента с роли (история не удаляется — только деактивация),
-- чтобы host-мост выбирал локального исполнителя, а не LLM-агента.
UPDATE agents SET is_active = false WHERE code = 'claude_pipeline';

COMMIT;

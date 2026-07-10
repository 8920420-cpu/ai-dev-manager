-- =====================================================================
-- Runner / обратный мост БД → файл (ИДЕМПОТЕНТНАЯ миграция).
-- Частичный индекс под выборку следующей задачи для Claude:
-- claimNextClaudeTask берёт CODING-задачи без назначенного агента.
-- =====================================================================
BEGIN;

CREATE INDEX IF NOT EXISTS idx_tasks_claude_claim
    ON tasks(priority DESC, created_at)
    WHERE status = 'CODING' AND assigned_agent_id IS NULL;

COMMIT;

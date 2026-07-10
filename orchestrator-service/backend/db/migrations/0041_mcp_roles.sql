-- =====================================================================
-- MCP-ROLES-001 — раздел «MCP роли».
--
-- Что: роли, которые можно использовать через MCP (Model Context Protocol).
--   У такой роли хранится промт (roles.prompt, уже есть) и требования к роли
--   (новое поле roles.requirements). Отдельная таблица не заводится — MCP-роль
--   это обычная строка roles с флагом is_mcp_role=true, что даёт единый CRUD,
--   переиспользование карточки/промта и совместимость с историей/agent_runs.
--
-- Модель:
--   * roles.is_mcp_role  — булев флаг: роль доступна через MCP (по нему фильтрует
--                          раздел «MCP роли» и MCP-инструменты). Пайплайновые роли
--                          остаются с false и в разделе не показываются.
--   * roles.requirements — свободный текст требований к роли (что нужно роли для
--                          работы: доступы, данные, ограничения). NULL = не задано.
--
-- Идемпотентно: ADD COLUMN IF NOT EXISTS, повторный запуск безопасен.
-- Существующие данные не меняются: новые колонки получают DEFAULT false / NULL.
-- =====================================================================
BEGIN;

ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_mcp_role boolean NOT NULL DEFAULT false;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS requirements text;

COMMENT ON COLUMN roles.is_mcp_role IS 'Роль доступна для использования через MCP (раздел «MCP роли»).';
COMMENT ON COLUMN roles.requirements IS 'Требования к MCP-роли (свободный текст): доступы, данные, ограничения. NULL = не задано.';

-- Частичный индекс: раздел и MCP-инструменты читают только MCP-роли.
CREATE INDEX IF NOT EXISTS idx_roles_is_mcp_role ON roles(is_mcp_role) WHERE is_mcp_role = true;

COMMIT;

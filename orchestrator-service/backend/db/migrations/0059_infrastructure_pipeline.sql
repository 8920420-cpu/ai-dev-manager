-- =====================================================================
-- INFRA-DEPARTMENT-001 (Вариант 2) — исполнимый Инфраструктурный отдел.
--
-- Дополняет 0058 (роли + промты) до РАБОТАЮЩЕГО конвейера:
--   1) projects.pipeline_kind — метка отдельного конвейера. Проекты
--      'infrastructure' исключаются из материализации единой дев-схемы (guard в
--      applySchemeToProject) и получают СВОЙ граф этапов через infraScheme.js.
--   2) role_connectors — движки инфра-ролей: reasoning-роли на драйверах
--      claude_code (архитектор + 7 доменных исполнителей, правят IaC-файлы) и
--      codex (гейты ИБ/SRE + проверка мониторинга). Финальный commit ведёт общий
--      GIT_INTEGRATOR (host-мост, коннектор не нужен).
--
-- Роли уже заведены в ROLE_FLOW/ROLE_KINDS/LLM_ROLE_CODES (код ядра). Сам инфра-граф
-- (project_stages + рёбра fork/join) материализует seed-скрипт вызовом
-- infraScheme.saveInfraSchemeRows — SQL граф не строит (нужны роль-id и стабильные ключи).
--
-- Идемпотентно: ADD COLUMN IF NOT EXISTS; role_connectors — ON CONFLICT(role_code)
-- DO NOTHING (не перетираем движок, выбранный пользователем в карточке роли).
-- =====================================================================
BEGIN;

-- --- 1. Тип конвейера проекта ----------------------------------------------
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS pipeline_kind text NOT NULL DEFAULT 'development';

COMMENT ON COLUMN projects.pipeline_kind IS
  'Конвейер проекта: development (единая дев-схема) | infrastructure (свой инфра-граф, INFRA-DEPARTMENT-001).';

-- --- 2. Движки инфра-ролей (role_connectors) -------------------------------
-- Драйвер claude_code: инфраструктурный архитектор + семь доменных исполнителей.
INSERT INTO role_connectors (role_code, connector_id)
SELECT v.code, cn.id
  FROM (VALUES
    ('INFRA_ARCHITECT'), ('SYSADMIN'), ('DEVOPS_ENGINEER'), ('NETWORK_ENGINEER'),
    ('K8S_ENGINEER'), ('DOCKER_ENGINEER'), ('VIRTUALIZATION_ENGINEER'), ('BACKUP_ENGINEER')
  ) AS v(code)
  CROSS JOIN LATERAL (
    SELECT id FROM connectors
     WHERE provider = 'claude_code' AND is_enabled = true
     ORDER BY priority ASC, updated_at DESC LIMIT 1
  ) cn
ON CONFLICT (role_code) DO NOTHING;

-- Драйвер codex: гейты ИБ и SRE + проверка мониторинга (read-only рассуждение).
INSERT INTO role_connectors (role_code, connector_id)
SELECT v.code, cn.id
  FROM (VALUES
    ('SECURITY_ENGINEER'), ('SRE_ENGINEER'), ('MONITORING_ENGINEER')
  ) AS v(code)
  CROSS JOIN LATERAL (
    SELECT id FROM connectors
     WHERE provider = 'codex' AND is_enabled = true
     ORDER BY priority ASC, updated_at DESC LIMIT 1
  ) cn
ON CONFLICT (role_code) DO NOTHING;

COMMIT;

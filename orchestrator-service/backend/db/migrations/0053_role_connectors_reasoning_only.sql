-- =====================================================================
-- ROLE-CONNECTOR-REASONING-ONLY-001 — оставить назначение движка (коннектора)
-- ТОЛЬКО у рассуждающих ролей. Обратимая идемпотентная миграция.
-- =====================================================================
-- Проблема: в role_connectors назначены reasoning-«движки» ролям, которые их не
-- исполняют (PIPELINE_SERVICE/GIT_INTEGRATOR — host-runner; SCANNER — файловый
-- сервис; TESTER — вне активного маршрута; PROGRAMMER — отдельный конвейер Claude
-- Code). Это вводит оператора и UI в заблуждение. Оставляем движок только у
-- рассуждающих ролей (источник истины — LLM_ROLE_CODES в roleEngine.js и
-- REASONING_ROLES в src/features/settings/roleEngines.ts):
--   TASK_INTAKE_OFFICER, ARCHITECT, DECOMPOSER, TASK_REVIEWER, FAILURE_ANALYST,
--   DOCUMENTATION_AUDITOR, DOCUMENTATION_KEEPER.
--
-- НЕ удаляем вслепую: сначала копируем удаляемые строки в бэкап-таблицу
-- role_connectors_backup_0053 (Шаг 1), затем удаляем их (Шаг 2). Фильтруем ТОЛЬКО
-- по role_code (UPPER/TRIM) — id/провайдер коннектора не учитываем. Строки семи
-- reasoning-ролей не трогаем. Идемпотентно: повторный прогон backup-INSERT ничего
-- не добавит (строки уже удалены), CREATE TABLE — IF NOT EXISTS.
--
-- ОБРАТНЫЙ SQL (восстановление из бэкапа, если чистку нужно откатить):
--   INSERT INTO role_connectors (role_code, connector_id, updated_at)
--   SELECT role_code, connector_id, updated_at FROM role_connectors_backup_0053
--   ON CONFLICT (role_code) DO UPDATE
--     SET connector_id = EXCLUDED.connector_id, updated_at = EXCLUDED.updated_at;
-- =====================================================================

BEGIN;

-- Шаг 1. Бэкап удаляемых (не-reasoning) назначений — перед удалением.
CREATE TABLE IF NOT EXISTS role_connectors_backup_0053 (
    role_code    text,
    connector_id uuid,
    updated_at   timestamptz
);

INSERT INTO role_connectors_backup_0053 (role_code, connector_id, updated_at)
SELECT role_code, connector_id, updated_at
  FROM role_connectors
 WHERE UPPER(TRIM(role_code)) NOT IN (
     'TASK_INTAKE_OFFICER',
     'ARCHITECT',
     'DECOMPOSER',
     'TASK_REVIEWER',
     'FAILURE_ANALYST',
     'DOCUMENTATION_AUDITOR',
     'DOCUMENTATION_KEEPER'
 );

-- Шаг 2. Удалить только перечисленные не-reasoning назначения. Строки семи
-- рассуждающих ролей остаются нетронутыми.
DELETE FROM role_connectors
 WHERE UPPER(TRIM(role_code)) NOT IN (
     'TASK_INTAKE_OFFICER',
     'ARCHITECT',
     'DECOMPOSER',
     'TASK_REVIEWER',
     'FAILURE_ANALYST',
     'DOCUMENTATION_AUDITOR',
     'DOCUMENTATION_KEEPER'
 );

COMMIT;

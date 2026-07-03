-- =====================================================================
-- TASK-INTAKE-OFFICER-MCP-001 — Приёмщик задач (Task Intake Officer) доступен
-- через MCP как «Постановщик задач».
--
-- Что и зачем:
--   Мы НЕ заводим отдельную роль-дубль, а модернизируем существующий
--   TASK_INTAKE_OFFICER: помечаем его is_mcp_role=true, чтобы одна и та же роль
--   работала и в конвейере, и через MCP (её карточку/промт отдают инструменты
--   orchestrator_list_mcp_roles / orchestrator_get_mcp_role). Так «MCP-постановщик»
--   и «Task Intake Officer» — это буквально одна роль: они равны по построению,
--   без копирования промта и контракта полей.
--
--   Флаг is_mcp_role используется ТОЛЬКО разделом «MCP роли» (mcpRoles.js). Claim
--   конвейера и список ролей его не фильтруют — роль остаётся полноценным первым
--   этапом конвейера и одновременно появляется в разделе «MCP роли».
--
--   requirements описывает порядок работы через MCP: результат постановщика
--   (готовый интейк) отправляется сразу в Architect (см. entryRole/intakeCompleted
--   в /api/scanner/task-intake и инструменте orchestrator_create_task), минуя
--   пайплайновый Приёмщик/BACKLOG.
--
-- Идемпотентно: повторный запуск безопасен (UPDATE по коду роли).
-- =====================================================================
BEGIN;

UPDATE roles
   SET is_mcp_role = true,
       requirements = $req$Роль доступна через MCP как «Постановщик задач» (это тот же Task Intake Officer, что и первый этап конвейера).

Порядок работы через MCP:
1. Прочитать промт роли: orchestrator_get_mcp_role с roleCode=TASK_INTAKE_OFFICER — применить его как системную инструкцию.
2. Выполнить приёмку по контракту полей роли (short_title, task_title, structured_description, project_understanding, task_type, project, service, component, user_goal, original_request, confidence, blocking_questions, optional_questions, assumptions). Файлы не читать, решение не проектировать.
3. Сдать результат вызовом orchestrator_create_task с intakeCompleted=true — задача создаётся СРАЗУ в статусе ARCHITECTURE под ролью Architect, минуя пайплайновый Приёмщик/BACKLOG.

Обязательно указывай проект (projectPath — абсолютный путь папки проекта, либо project). short_title → title, structured_description → description; остальную карточку интейка передавай в card (сохранится в data_card для Architect).

Если есть blocking_questions — не отправляй задачу: сначала получи ответы у пользователя.$req$
 WHERE code = 'TASK_INTAKE_OFFICER';

COMMIT;

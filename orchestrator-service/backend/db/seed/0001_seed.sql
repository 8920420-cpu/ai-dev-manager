-- =====================================================================
-- AI Orchestrator — пример данных (seed)
-- Идемпотентно: ON CONFLICT DO NOTHING по натуральным ключам.
-- =====================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- Roles (этапы пайплайна)
-- ---------------------------------------------------------------------
INSERT INTO roles (code, name, description, sort_order) VALUES
    ('ARCHITECT',             'Architect',             'Проектирует решение и критерии приёмки.',                    10),
    ('DECOMPOSER',            'Decomposer',            'Разбивает решение на независимые проверяемые задачи.',       20),
    ('PROGRAMMER',            'Programmer',            'Реализует одну задачу и локальные тесты.',                   30),
    ('SCANNER',               'Scanner',               'Отслеживает документ Claude и передаёт завершённые задачи.', 40),
    ('TASK_REVIEWER',         'Task Reviewer',         'Проверяет diff до запуска pipeline.',                        50),
    ('PIPELINE_SERVICE',      'Pipeline Service',      'Запускает автоматические проверки и сохраняет артефакты.',  60),
    ('FAILURE_ANALYST',       'Failure Analyst',       'Анализирует падение pipeline и возвращает задачу Programmer.',70),
    ('DOCUMENTATION_AUDITOR', 'Documentation Auditor', 'Определяет необходимость обновления документации.',         80),
    ('DOCUMENTATION_KEEPER',  'Documentation Keeper',  'Обновляет подтверждённо устаревшие документы.',             90),
    ('GIT_INTEGRATOR',        'Git Integrator',        'Фиксирует проверенные изменения в Git.',                    100)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------
-- Agents
-- ---------------------------------------------------------------------
INSERT INTO agents (code, name, provider, model, role_id, is_active)
SELECT v.code, v.name, v.provider, v.model, r.id, true
FROM (VALUES
    ('codex_architect',          'Codex Architect',             'openai',    'gpt-5-codex',      'ARCHITECT'),
    ('codex_decomposer',         'Codex Decomposer',            'openai',    'gpt-5-codex',      'DECOMPOSER'),
    ('claude_programmer',        'Claude Programmer',           'anthropic', 'claude-opus-4-8',  'PROGRAMMER'),
    ('local_scanner',            'Local Task Scanner',           'local',     'scanner-service',  'SCANNER'),
    ('codex_task_reviewer',      'Codex Task Reviewer',         'openai',    'gpt-5-codex',      'TASK_REVIEWER'),
    ('local_pipeline',           'Local Pipeline Runner',       'local',     'pipeline-runner',  'PIPELINE_SERVICE'),
    ('claude_analyst',           'Claude Failure Analyst',      'anthropic', 'claude-opus-4-8',  'FAILURE_ANALYST'),
    ('codex_doc_auditor',        'Codex Documentation Auditor', 'openai',    'gpt-5-codex',      'DOCUMENTATION_AUDITOR'),
    ('claude_doc_keeper',        'Claude Documentation Keeper', 'anthropic', 'claude-sonnet-4-6','DOCUMENTATION_KEEPER'),
    ('claude_git_integrator',    'Claude Git Integrator',       'anthropic', 'claude-haiku-4-5', 'GIT_INTEGRATOR')
) AS v(code, name, provider, model, role_code)
JOIN roles r ON r.code = v.role_code
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------
-- Role groups (смысловые группы экрана «Роли») + раскладка пресетных ролей.
-- На чистой установке роли создаются выше (после миграций), поэтому раскладку
-- проставляем здесь. Идемпотентно: группа — по имени, привязка — только если
-- у роли ещё нет группы (не перетираем пользовательскую раскладку).
-- ---------------------------------------------------------------------
INSERT INTO role_groups (name, sort_order) VALUES
    ('Аналитика и планирование', 10),
    ('Разработка',               20),
    ('Контроль качества',        30),
    ('Документация и структура', 40),
    ('Интеграция и доставка',    50)
ON CONFLICT (lower(name)) DO NOTHING;

UPDATE roles r SET group_id = g.id
  FROM role_groups g
 WHERE r.group_id IS NULL
   AND g.name = CASE r.code
     WHEN 'ARCHITECT'             THEN 'Аналитика и планирование'
     WHEN 'DECOMPOSER'            THEN 'Аналитика и планирование'
     WHEN 'PROGRAMMER'            THEN 'Разработка'
     WHEN 'SCANNER'               THEN 'Разработка'
     WHEN 'TASK_REVIEWER'         THEN 'Контроль качества'
     WHEN 'PIPELINE_SERVICE'      THEN 'Контроль качества'
     WHEN 'FAILURE_ANALYST'       THEN 'Контроль качества'
     WHEN 'DOCUMENTATION_AUDITOR' THEN 'Документация и структура'
     WHEN 'DOCUMENTATION_KEEPER'  THEN 'Документация и структура'
     WHEN 'STRUCTURE_KEEPER'      THEN 'Документация и структура'
     WHEN 'GIT_INTEGRATOR'        THEN 'Интеграция и доставка'
     ELSE NULL
   END;

-- ---------------------------------------------------------------------
-- Prompts (версия 1, активная — по одной на роль)
-- ---------------------------------------------------------------------
INSERT INTO prompts (role_id, version, prompt_text, is_active)
SELECT r.id, 1,
       'You are the ' || r.name || ' role in AI Orchestrator. Follow DECISIONS.md and the project maps. Use only provided context; do not invent requirements, files, services, results, or checks.',
       true
FROM roles r
ON CONFLICT (role_id, version) DO NOTHING;

-- ---------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------
INSERT INTO projects (code, name, description) VALUES
    ('PS',       'PS',           'Корневой проект платформы.'),
    ('CHAT',     'Chat_Service', 'Сервис чатов.'),
    ('IAM',      'IAM_Service',  'Identity & Access Management.'),
    ('WEBSTORE', 'WebStore',     'Интернет-магазин.'),
    ('PS_TORG',  'PS-Torg',      'Торговая платформа.')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------
-- Services
-- ---------------------------------------------------------------------
INSERT INTO services (project_id, service_code, service_name, description, repository_path)
SELECT p.id, v.service_code, v.service_name, v.description, v.repository_path
FROM (VALUES
    ('PS', 'Catalog_Service',   'Catalog Service',   'Источник номенклатуры.',  'services/catalog'),
    ('PS', 'IAM_Service',       'IAM Service',       'Аутентификация/авторизация.', 'services/iam'),
    ('PS', 'Chat_Service',      'Chat Service',      'Чаты и сообщения.',       'services/chat'),
    ('PS', 'Connector_Service', 'Connector Service', 'Внешние интеграции.',     'services/connector')
) AS v(project_code, service_code, service_name, description, repository_path)
JOIN projects p ON p.code = v.project_code
ON CONFLICT (project_id, service_code) DO NOTHING;

-- ---------------------------------------------------------------------
-- Service dependencies: Chat_Service -> IAM_Service, Catalog -> IAM
-- ---------------------------------------------------------------------
INSERT INTO service_dependencies (source_service_id, target_service_id, dependency_type)
SELECT s1.id, s2.id, v.dep::service_dep_type
FROM (VALUES
    ('Chat_Service',    'IAM_Service',     'GRPC'),
    ('Catalog_Service', 'IAM_Service',     'GRPC'),
    ('Chat_Service',    'Connector_Service','REST')
) AS v(src, tgt, dep)
JOIN services s1 ON s1.service_code = v.src
JOIN services s2 ON s2.service_code = v.tgt
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- Knowledge documents (карты проекта PS)
-- ---------------------------------------------------------------------
INSERT INTO knowledge_documents (project_id, document_type, file_path, checksum, version)
SELECT p.id, v.dt::document_type, v.path, NULL, 1
FROM (VALUES
    ('PROJECT_MAP',  'docs/PROJECT_MAP.md'),
    ('ARCHITECTURE', 'docs/ARCHITECTURE.md'),
    ('API_MAP',      'docs/API_MAP.md'),
    ('DATABASE_MAP', 'docs/DATABASE_MAP.md'),
    ('DECISIONS',    'docs/DECISIONS.md')
) AS v(dt, path)
JOIN projects p ON p.code = 'PS'
ON CONFLICT (project_id, document_type) DO NOTHING;

-- ---------------------------------------------------------------------
-- Пример задачи + событие создания
-- ---------------------------------------------------------------------
INSERT INTO tasks (project_id, service_id, title, description, priority, status, current_role_id, created_by)
SELECT p.id, s.id,
       'Добавить печатную форму счёта',
       'Реализовать генерацию PDF счёта в Catalog_Service.',
       'HIGH', 'READY',
       (SELECT id FROM roles WHERE code = 'ARCHITECT'),
       'orchestrator'
FROM projects p
JOIN services s ON s.service_code = 'Catalog_Service'
WHERE p.code = 'PS'
  AND NOT EXISTS (SELECT 1 FROM tasks WHERE title = 'Добавить печатную форму счёта');

INSERT INTO task_events (task_id, event_type, to_status, role_id, payload_json)
SELECT t.id, 'TASK_CREATED', 'READY',
       (SELECT id FROM roles WHERE code = 'ARCHITECT'),
       jsonb_build_object('created_by','orchestrator')
FROM tasks t
WHERE t.title = 'Добавить печатную форму счёта'
  AND NOT EXISTS (
      SELECT 1 FROM task_events e
      WHERE e.task_id = t.id AND e.event_type = 'TASK_CREATED');

COMMIT;

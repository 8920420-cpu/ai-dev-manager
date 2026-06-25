-- Канонический набор ролей task pipeline.
-- Миграция не удаляет старые роли: существующие исторические ссылки сохраняются.
BEGIN;

INSERT INTO roles (code, name, description, sort_order) VALUES
    ('ARCHITECT',             'Architect',             'Проектирует решение и критерии приёмки.',                     10),
    ('DECOMPOSER',            'Decomposer',            'Разбивает решение на независимые проверяемые задачи.',        20),
    ('PROGRAMMER',            'Programmer',            'Реализует одну задачу и локальные тесты.',                    30),
    ('SCANNER',               'Scanner',               'Отслеживает документ Claude и передаёт завершённые задачи.',  40),
    ('TASK_REVIEWER',         'Task Reviewer',         'Проверяет diff до запуска pipeline.',                         50),
    ('PIPELINE_SERVICE',      'Pipeline Service',      'Запускает автоматические проверки и сохраняет артефакты.',   60),
    ('FAILURE_ANALYST',       'Failure Analyst',       'Анализирует падение pipeline и возвращает задачу Programmer.',70),
    ('DOCUMENTATION_AUDITOR', 'Documentation Auditor', 'Определяет необходимость обновления документации.',          80),
    ('DOCUMENTATION_KEEPER',  'Documentation Keeper',  'Обновляет подтверждённо устаревшие документы.',              90),
    ('GIT_INTEGRATOR',        'Git Integrator',        'Фиксирует проверенные изменения в Git.',                     100)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order;

INSERT INTO agents (code, name, provider, model, role_id, is_active)
SELECT v.code, v.name, v.provider, v.model, r.id, true
FROM (VALUES
    ('codex_architect',       'Codex Architect',             'openai',    'gpt-5-codex',       'ARCHITECT'),
    ('codex_decomposer',      'Codex Decomposer',            'openai',    'gpt-5-codex',       'DECOMPOSER'),
    ('claude_programmer',     'Claude Programmer',           'anthropic', 'claude-opus-4-8',   'PROGRAMMER'),
    ('local_scanner',         'Local Task Scanner',           'local',     'scanner-service',   'SCANNER'),
    ('codex_task_reviewer',   'Codex Task Reviewer',         'openai',    'gpt-5-codex',       'TASK_REVIEWER'),
    ('local_pipeline',        'Local Pipeline Runner',       'local',     'pipeline-runner',   'PIPELINE_SERVICE'),
    ('claude_analyst',        'Claude Failure Analyst',      'anthropic', 'claude-opus-4-8',   'FAILURE_ANALYST'),
    ('codex_doc_auditor',     'Codex Documentation Auditor', 'openai',    'gpt-5-codex',       'DOCUMENTATION_AUDITOR'),
    ('claude_doc_keeper',     'Claude Documentation Keeper', 'anthropic', 'claude-sonnet-4-6', 'DOCUMENTATION_KEEPER'),
    ('claude_git_integrator', 'Claude Git Integrator',       'anthropic', 'claude-haiku-4-5',  'GIT_INTEGRATOR')
) AS v(code, name, provider, model, role_code)
JOIN roles r ON r.code = v.role_code
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    provider = EXCLUDED.provider,
    model = EXCLUDED.model,
    role_id = EXCLUDED.role_id,
    is_active = true;

COMMIT;

-- =====================================================================
-- TASK-INTAKE-OFFICER-001 — роль «Приёмщик задач» (Task Intake Officer).
-- Идемпотентная миграция (повторный запуск безопасен).
-- =====================================================================
-- Приёмщик задач — ПЕРВАЯ роль в движении задачи по ролям. Принимает сырой запрос
-- пользователя, классифицирует его (тип, проект, сервис, компонент, цель) и готовит
-- карточку задачи для маршрутизации. Не пишет код, не проектирует, не декомпозирует,
-- не выбирает следующую роль и не меняет проект.
--
-- Источники задач для Приёмщика (он сам файлы НЕ читает — работает только с БД):
--   1) Scanner — отдельная роль ВНЕ цепочки: следит за папкой документов проекта
--      (projects.docs_path), забирает файл задачи, пишет задачу в БД, удаляет файл
--      и ставит задаче роль = TASK_INTAKE_OFFICER;
--   2) модальное окно создания задачи в UI.
-- Все остальные роли работают ТОЛЬКО с БД (читают/меняют/пишут задачи в БД).
--
-- Эта миграция также пересобирает единую «Схему разработки» (global_stages) в
-- канонический порядок: Приёмщик первым, Scanner из цепочки убран — и зеркалит
-- схему в project_stages всех проектов (runner читает project_stages).
-- =====================================================================

BEGIN;

-- --- Роль -------------------------------------------------------------------
INSERT INTO roles (code, name, description, sort_order) VALUES
    ('TASK_INTAKE_OFFICER', 'Task Intake Officer',
     'Приёмщик задач: классифицирует входящий запрос и готовит карточку задачи. Первая роль в цепочке.',
     8)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order;

-- Исполнитель роли — рассуждающий ИИ-агент (роль входит в LLM_ROLE_CODES).
INSERT INTO agents (code, name, provider, model, role_id, is_active)
SELECT 'claude_intake_officer', 'Claude Task Intake Officer', 'anthropic', 'claude-opus-4-8', r.id, true
  FROM roles r WHERE r.code = 'TASK_INTAKE_OFFICER'
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    provider = EXCLUDED.provider,
    model = EXCLUDED.model,
    role_id = EXCLUDED.role_id,
    is_active = true;

-- --- Рабочий промт роли (только если ещё не задан) --------------------------
UPDATE roles SET prompt = $intake$# Роль: Task Intake Officer (Приёмщик задач)

## Назначение

Ты — первая роль в цепочке обработки задач. Ты принимаешь сырой запрос пользователя и готовишь карточку задачи для дальнейшей маршрутизации оркестратором.

Единственная задача роли — максимально точно понять запрос пользователя и классифицировать его. Ничего не придумывай сверх сказанного.

## Чего роль НЕ делает

Запрещено: писать код; предлагать решение; проектировать архитектуру; разбивать задачу на подзадачи; выбирать технологии или сервисы для реализации; определять следующую роль; менять файлы; выполнять задачу.

## Что нужно определить

1. **Тип задачи** (один или несколько): bugfix, feature, improvement, refactoring, optimization, frontend, backend, database, api, integration, security, devops, infrastructure, testing, documentation, analytics, migration, unknown.
2. **Проект** (например: CRM, PS-Torg, WebStore, Chat_Service, Catalog_Service, IAM_Service, Connector_Service, Android_App, Infrastructure). Если определить нельзя — `unknown`.
3. **Сервис** (например: Catalog_Service, Chat_Service, IAM_Service, Front_SalesFlow, PSweb, Android_Client, Gateway). Если нельзя — `unknown`.
4. **Компонент** (например: Cart, Authentication, User List, Orders, Pricing Engine, Catalog Tree, Notifications). Если нельзя — `unknown`.
5. **Цель пользователя** — самое важное. Опиши, ЧТО пользователь хочет получить в результате. Запрещено придумывать решение/архитектуру/код — только конечная цель. Плохо: «Нужно изменить React‑компонент». Хорошо: «Пользователь хочет, чтобы товары, уже находящиеся в корзине, не отображались в списке доступной номенклатуры».
6. **Исходный запрос** — сохранить оригинальный смысл, не искажать требования и ограничения.
7. **Уровень уверенности**: high | medium | low.
8. **Вопросы**: blocking_questions (без ответа на которые задачу нельзя маршрутизировать) и optional_questions (уточняющие). Если вопросов нет — пустые списки.
9. **Предположения**: если делал выводы из контекста — указать отдельно. Никогда не выдавать предположения за факты.

## Точность важнее полноты

Если уверенность в проекте или сервисе ниже 70% — не угадывай, ставь `unknown`.

## Самопроверка перед завершением

Понял ли я, что хочет пользователь? Определил ли тип/проект/сервис/компонент? Не придумал ли требования? Не предложил ли архитектуру/решение/код? Достаточно ли информации для маршрутизации? Если хоть один пункт не выполнен — исправь результат.

## Формат результата

Статусы роли:
- `READY` — карточка готова, blocking_questions отсутствуют → задача идёт дальше по маршруту;
- `BLOCKED` — есть blocking_questions, нужен ответ пользователя → задача ждёт уточнения.

В поле `summary` дай краткое резюме. Карточку задачи помести в `fields` следующими ключами:
`task_title, task_type (список), project, service, component, user_goal, original_request, confidence, blocking_questions (список), optional_questions (список), assumptions (список)`.
$intake$
WHERE code = 'TASK_INTAKE_OFFICER' AND (prompt IS NULL OR prompt = '');

-- --- Пересборка единой схемы: Приёмщик первым, Scanner вне цепочки -----------
-- Делаем один раз: если этап Приёмщика ещё не в схеме.
DO $rebuild$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM global_stages gs
      JOIN global_stage_roles gsr ON gsr.stage_id = gs.id
      JOIN roles r ON r.id = gsr.role_id
     WHERE r.code = 'TASK_INTAKE_OFFICER'
  ) THEN
    DELETE FROM global_stages; -- каскадно очищает global_stage_roles

    WITH spec(position, name, role_code, status) AS (
      VALUES
        (0,  'Приёмщик задач',        'TASK_INTAKE_OFFICER',   'BACKLOG'),
        (1,  'Architect',             'ARCHITECT',             'ARCHITECTURE'),
        (2,  'Decomposer',            'DECOMPOSER',            'DECOMPOSITION'),
        (3,  'Programmer',            'PROGRAMMER',            'CODING'),
        (4,  'Task Reviewer',         'TASK_REVIEWER',         'REVIEW'),
        (5,  'Pipeline Service',      'PIPELINE_SERVICE',      'TESTING'),
        (6,  'Failure Analyst',       'FAILURE_ANALYST',       'FAILURE_ANALYSIS'),
        (7,  'Documentation Auditor', 'DOCUMENTATION_AUDITOR', 'COMMIT'),
        (8,  'Documentation Keeper',  'DOCUMENTATION_KEEPER',  'COMMIT'),
        (9,  'Git Integrator',        'GIT_INTEGRATOR',        'COMMIT')
    ),
    ins AS (
      INSERT INTO global_stages (position, name, enabled, task_status)
      SELECT position, name, true, status::task_status FROM spec
      RETURNING id, position
    )
    INSERT INTO global_stage_roles (stage_id, role_id, position)
    SELECT ins.id, r.id, 0
      FROM ins
      JOIN spec ON spec.position = ins.position
      JOIN roles r ON r.code = spec.role_code;

    -- Зеркалим единую схему в project_stages всех проектов (без Scanner-папки).
    DELETE FROM project_stages; -- каскадно очищает project_stage_roles

    INSERT INTO project_stages (project_id, position, name, enabled, watch_directory, task_status)
    SELECT p.id, gs.position, gs.name, gs.enabled, NULL, gs.task_status
      FROM projects p CROSS JOIN global_stages gs;

    INSERT INTO project_stage_roles (stage_id, role_id, position)
    SELECT ps.id, gsr.role_id, gsr.position
      FROM project_stages ps
      JOIN global_stages gs ON gs.position = ps.position
      JOIN global_stage_roles gsr ON gsr.stage_id = gs.id;
  END IF;
END
$rebuild$;

COMMIT;

-- =====================================================================
-- TASK-ROUTER-001 — роли Task Router и Mini Architect + условная развилка контура.
-- Идемпотентная миграция (повторный запуск безопасен; правит граф ДЕВ-схемы, INFRA
-- со своим графом не трогает).
-- =====================================================================
-- После Приёмщика задача идёт к Task Router (лёгкий триаж): он выбирает КОНТУР
-- small|medium|large (route). Реальная развилка выражена УСЛОВНЫМИ рёбрами графа:
--   Intake → Router → (route=small) → Mini Architect → Programmer → …
--                   → (fallback)    → Architect      → Programmer → …
-- Mini Architect — облегчённый архитектор small-контура (без разведки/расщепления).
-- Полный Architect (medium/large) может ЭСКАЛИРОВАТЬ сложность (ARCH-SIZE-ESCALATION-001).
--
-- route — ГЛАВНОЕ решение после Router; task_size остаётся вспомогательным hint (сервер
-- синхронизирует task_size = route, см. applyReasoningVerdict TASK_ROUTER). Отсутствие/
-- мусор route → medium (полный Архитектор — безопасный дефолт).
--
-- Развилку в графе понимает движок: outcomeLabel учитывает decision.branchLabel
-- (route), а pickEdgeKey выбирает ребро по condition (graphRoute.js). Рёбра проекта —
-- копия глобальных (developmentScheme.applyEdgesToProject сохраняет condition), так что
-- условные рёбра переживают ре-синк схемы из UI.
--
-- Движки ролей (role_connectors): Router → внутренний DeepSeek (дёшево/быстро —
-- классификатор без инструментов); Mini Architect → тот же движок, что у Architect
-- (claude_code драйвер — качество work item + доступ к файлам). Переназначаются в UI.
-- =====================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- 1. Роли.
-- ---------------------------------------------------------------------
INSERT INTO roles (code, name, description, sort_order) VALUES
  ('TASK_ROUTER', 'Task Router',
   'Маршрутизатор задач: лёгкий триаж после Приёмщика — выбирает контур small|medium|large.', 9),
  ('MINI_ARCHITECT', 'Mini Architect',
   'Облегчённый архитектор small-контура: короткий work item без разведки и расщепления.', 10)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, description = EXCLUDED.description, sort_order = EXCLUDED.sort_order;

-- ---------------------------------------------------------------------
-- 2. ИИ-агенты ролей (нужны для claim: SELECT id FROM agents WHERE role_id).
--    Модель/провайдер агента — информативные; фактический движок задаёт role_connectors.
-- ---------------------------------------------------------------------
INSERT INTO agents (code, name, provider, model, role_id, is_active)
SELECT 'claude_task_router', 'Task Router (DeepSeek)', 'deepseek', 'deepseek-reasoner', r.id, true
  FROM roles r WHERE r.code = 'TASK_ROUTER'
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, provider = EXCLUDED.provider, model = EXCLUDED.model,
  role_id = EXCLUDED.role_id, is_active = true;

INSERT INTO agents (code, name, provider, model, role_id, is_active)
SELECT 'claude_mini_architect', 'Mini Architect', 'anthropic', 'claude-opus-4-8', r.id, true
  FROM roles r WHERE r.code = 'MINI_ARCHITECT'
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, provider = EXCLUDED.provider, model = EXCLUDED.model,
  role_id = EXCLUDED.role_id, is_active = true;

-- ---------------------------------------------------------------------
-- 3. Словарь полей (все ключи новые). json-поля храним как text с JSON-строкой
--    (как принято для valueType=json в контракте вердикта).
-- ---------------------------------------------------------------------
INSERT INTO fields (key, name, description, value_type) VALUES
  ('route', 'Route', 'Контур маршрута от Task Router: small|medium|large. Главное решение после Router (task_size — вспомогательный hint). Мусор/пусто → medium.', 'text'),
  ('route_confidence', 'Route confidence', 'Уверенность Router в выбранном контуре: high|medium|low.', 'text'),
  ('route_reason', 'Route reason', 'Краткое обоснование выбранного контура.', 'text'),
  ('needs_clarification', 'Needs clarification', 'Нужно ли уточнение перед выбором контура (true|false).', 'text'),
  ('clarification_question', 'Clarification question', 'Один конкретный уточняющий вопрос, если контур выбрать нельзя.', 'text'),
  ('suggested_roles', 'Suggested roles', 'Предполагаемые роли/этапы для контура (JSON-строка).', 'text'),
  ('task_size_factors', 'Task size factors', 'Факторы оценки размера/риска задачи (JSON-строка).', 'text'),
  ('work_item', 'Work item', 'Конкретная задача Программисту: что именно сделать.', 'text'),
  ('target_service', 'Target service', 'Целевой сервис правки (service_code).', 'text'),
  ('target_area', 'Target area', 'Область/модуль правки внутри сервиса.', 'text'),
  ('candidate_files', 'Candidate files', 'Список кандидатов-файлов для правки.', 'list'),
  ('acceptance_criteria', 'Acceptance criteria', 'Критерии приёмки результата.', 'list'),
  ('scope_limits', 'Scope limits', 'Границы scope: чего НЕ трогать.', 'text'),
  ('test_hints', 'Test hints', 'Подсказки по тестам для узкой правки.', 'text'),
  ('test_plan', 'Test plan', 'План проверки/тестирования изменения.', 'text'),
  ('risk_notes', 'Risk notes', 'Заметки о рисках изменения.', 'text')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- 4. Контракт исходящих полей ролей (role_fields, direction=out).
-- ---------------------------------------------------------------------
-- TASK_ROUTER: route обязателен, остальное опционально.
INSERT INTO role_fields (role_id, field_id, direction, required, position)
SELECT r.id, f.id, 'out', v.required, v.position
  FROM (VALUES
    ('route', true, 0),
    ('route_confidence', false, 1),
    ('route_reason', false, 2),
    ('needs_clarification', false, 3),
    ('clarification_question', false, 4),
    ('suggested_roles', false, 5),
    ('task_size_factors', false, 6)
  ) AS v(key, required, position)
  JOIN fields f ON f.key = v.key
  JOIN roles r ON r.code = 'TASK_ROUTER'
ON CONFLICT (role_id, field_id, direction) DO UPDATE SET
  required = EXCLUDED.required, position = EXCLUDED.position;

-- MINI_ARCHITECT: work_item обязателен, остальное опционально.
INSERT INTO role_fields (role_id, field_id, direction, required, position)
SELECT r.id, f.id, 'out', v.required, v.position
  FROM (VALUES
    ('work_item', true, 0),
    ('target_service', false, 1),
    ('target_area', false, 2),
    ('candidate_files', false, 3),
    ('acceptance_criteria', false, 4),
    ('scope_limits', false, 5),
    ('test_hints', false, 6)
  ) AS v(key, required, position)
  JOIN fields f ON f.key = v.key
  JOIN roles r ON r.code = 'MINI_ARCHITECT'
ON CONFLICT (role_id, field_id, direction) DO UPDATE SET
  required = EXCLUDED.required, position = EXCLUDED.position;

-- ARCHITECT (item 7): доливаем ОПЦИОНАЛЬНЫЕ структурированные артефакты для Программиста/
-- Ревьюера (не дублируем существующие affected_services/affected_files/work_items).
INSERT INTO role_fields (role_id, field_id, direction, required, position)
SELECT r.id, f.id, 'out', false, v.position
  FROM (VALUES
    ('acceptance_criteria', 3),
    ('scope_limits', 4),
    ('test_plan', 5),
    ('risk_notes', 6)
  ) AS v(key, position)
  JOIN fields f ON f.key = v.key
  JOIN roles r ON r.code = 'ARCHITECT'
ON CONFLICT (role_id, field_id, direction) DO UPDATE SET
  required = EXCLUDED.required, position = EXCLUDED.position;

-- ---------------------------------------------------------------------
-- 5. Рабочие промты ролей (только если ещё не заданы — правки из UI не затираем).
-- ---------------------------------------------------------------------
UPDATE roles SET prompt = $router$# Роль: Task Router (Маршрутизатор задач)

## Назначение
Ты — лёгкая роль-триаж сразу после Приёмщика. По ГОТОВОЙ карточке задачи (тип, проект, сервис, компонент, цель, описание) и подсказкам о проекте/сервисах ты выбираешь КОНТУР обработки: `small` | `medium` | `large`.

Ты НЕ делаешь глубокую разведку по коду, НЕ проектируешь архитектуру, НЕ пишешь код. Решение принимай быстро и только по карточке.

## Правила выбора контура
- `small` — локальная правка UI/текста/конфигурации/документации или точечный багфикс; ОДИН сервис; низкий риск; отдельное ревью не требуется.
- `medium` — обычная задача в ОДНОМ сервисе: новая логика/эндпоинт, несколько файлов; нужны тесты и ревью. Это ДЕФОЛТ при любом сомнении.
- `large` — затрагивает ДВА и более сервиса; контракт grpc/rest; БД/миграции; инфраструктура; синхронизация/зеркалирование; нужна декомпозиция или исследование.

Если сомневаешься — выбирай `medium`. НЕ выбирай `large` «на всякий случай». `small` — только для действительно узких безопасных правок.

## Когда нужны уточнения
Если проект/сервис/цель неоднозначны и контур выбрать нельзя — поставь `needs_clarification: true` и задай ОДИН конкретный вопрос (`clarification_question`). Тогда статус BLOCKED.

## Формат результата
Статусы роли:
- `READY` — контур выбран, уточнения не нужны → задача идёт дальше;
- `BLOCKED` — нужно уточнение (`needs_clarification`) → задача ждёт ответа.

В `summary` дай краткий вывод. В `fields` заполни:
`route` (small|medium|large), `route_confidence` (high|medium|low), `route_reason`, `needs_clarification` (true|false), `clarification_question` (если нужно), `suggested_roles` (опц., JSON-строка), `task_size_factors` (опц., JSON-строка).
$router$
WHERE code = 'TASK_ROUTER' AND (prompt IS NULL OR prompt = '');

UPDATE roles SET prompt = $mini$# Роль: Mini Architect (Облегчённый архитектор)

## Назначение
Ты — облегчённый архитектор для МЕЛКИХ задач (контур small). По карточке задачи ты формируешь короткий, конкретный work item для Программиста в ОДНОМ сервисе. Полную разведку репозитория НЕ проводишь и scope НЕ расширяешь.

## Что нужно сделать
1. Определить целевой сервис (`target_service`, service_code) и область правки (`target_area`).
2. Дать точечный список кандидатов-файлов (`candidate_files`) — без сплошного обхода дерева.
3. Сформулировать критерии приёмки (`acceptance_criteria`) и границы scope (`scope_limits` — чего НЕ трогать).
4. Дать подсказки по тестам (`test_hints`).
5. Сформулировать `work_item` — понятную Программисту задачу: что именно изменить.

## Ограничения
- НЕ расширяй scope: одна узкая правка, один сервис.
- Разведку делай минимально и точечно; если данных не хватает — статус BLOCKED с конкретным вопросом.
- Если задача на деле оказалась КРУПНЕЕ small (несколько сервисов, контракты API, БД/миграции, инфраструктура) — статус BLOCKED и явно укажи это: задачу вернут на полный контур (Architect).

## Формат результата
Статусы роли:
- `READY` — work item готов → задача идёт к Программисту;
- `BLOCKED` — не хватает данных ИЛИ задача крупнее small.

В `summary` дай краткий вывод. В `fields` заполни:
`work_item`, `target_service`, `target_area`, `candidate_files` (список), `acceptance_criteria` (список), `scope_limits`, `test_hints`.
$mini$
WHERE code = 'MINI_ARCHITECT' AND (prompt IS NULL OR prompt = '');

-- ---------------------------------------------------------------------
-- 6. Движки ролей (role_connectors). PK = role_code, поэтому ON CONFLICT (role_code).
--    Router → внутренний DeepSeek (дёшево/быстро). Mini Architect → движок Architect.
-- ---------------------------------------------------------------------
INSERT INTO role_connectors (role_code, connector_id, updated_at)
SELECT 'TASK_ROUTER', cn.id, now()
  FROM connectors cn
 WHERE cn.provider = 'deepseek' AND cn.is_enabled = true
 ORDER BY cn.priority, cn.name LIMIT 1
ON CONFLICT (role_code) DO NOTHING;

INSERT INTO role_connectors (role_code, connector_id, updated_at)
SELECT 'MINI_ARCHITECT', rc.connector_id, now()
  FROM role_connectors rc
 WHERE rc.role_code = 'ARCHITECT' AND rc.connector_id IS NOT NULL
ON CONFLICT (role_code) DO NOTHING;

-- ---------------------------------------------------------------------
-- 7. Граф ДЕВ-схемы: узлы Router/Mini + условная развилка. Только линейные dev-
--    проекты (у которых есть узел ARCHITECT); INFRA (свой граф) не трогаем.
--    Идемпотентно: если узел Router уже в global — no-op.
-- ---------------------------------------------------------------------
DO $graph$
DECLARE
  v_router_key uuid := '7a5c0001-0000-4000-8000-000000000001';
  v_mini_key   uuid := '7a5c0001-0000-4000-8000-000000000002';
  v_intake_key uuid;
  v_arch_key   uuid;
  v_prog_key   uuid;
  v_router_rl  uuid;
  v_mini_rl    uuid;
  v_id         uuid;
  v_pos        int;
  p            record;
BEGIN
  SELECT id INTO v_router_rl FROM roles WHERE code = 'TASK_ROUTER';
  SELECT id INTO v_mini_rl   FROM roles WHERE code = 'MINI_ARCHITECT';
  IF v_router_rl IS NULL OR v_mini_rl IS NULL THEN RETURN; END IF;

  -- Идемпотентность: узел Router уже добавлен ранее.
  IF EXISTS (SELECT 1 FROM global_stages WHERE stage_key = v_router_key) THEN RETURN; END IF;

  -- Якоря дев-графа (стабильные ключи узлов Intake/Architect/Programmer из global).
  SELECT gs.stage_key INTO v_intake_key
    FROM global_stages gs JOIN global_stage_roles gsr ON gsr.stage_id = gs.id
    JOIN roles r ON r.id = gsr.role_id WHERE r.code = 'TASK_INTAKE_OFFICER'
    ORDER BY gs.position LIMIT 1;
  SELECT gs.stage_key INTO v_arch_key
    FROM global_stages gs JOIN global_stage_roles gsr ON gsr.stage_id = gs.id
    JOIN roles r ON r.id = gsr.role_id WHERE r.code = 'ARCHITECT'
    ORDER BY gs.position LIMIT 1;
  SELECT gs.stage_key INTO v_prog_key
    FROM global_stages gs JOIN global_stage_roles gsr ON gsr.stage_id = gs.id
    JOIN roles r ON r.id = gsr.role_id WHERE r.code = 'PROGRAMMER'
    ORDER BY gs.position LIMIT 1;
  -- Нет дев-графа (линейная/иная схема) → узлы/рёбра не трогаем (фолбэк ROLE_FLOW).
  IF v_intake_key IS NULL OR v_arch_key IS NULL OR v_prog_key IS NULL THEN RETURN; END IF;

  -- 7.1 GLOBAL: узлы Router и Mini Architect (статус ARCHITECTURE, обычный этап).
  SELECT COALESCE(MAX(position), 0) + 1 INTO v_pos FROM global_stages;
  INSERT INTO global_stages (position, name, enabled, task_status, kind, stage_key, join_key)
  VALUES (v_pos, 'Task Router', true, 'ARCHITECTURE'::task_status, 'stage', v_router_key, NULL)
  RETURNING id INTO v_id;
  INSERT INTO global_stage_roles (stage_id, role_id, position) VALUES (v_id, v_router_rl, 0)
  ON CONFLICT (stage_id, role_id) DO NOTHING;

  SELECT COALESCE(MAX(position), 0) + 1 INTO v_pos FROM global_stages;
  INSERT INTO global_stages (position, name, enabled, task_status, kind, stage_key, join_key)
  VALUES (v_pos, 'Mini Architect', true, 'ARCHITECTURE'::task_status, 'stage', v_mini_key, NULL)
  RETURNING id INTO v_id;
  INSERT INTO global_stage_roles (stage_id, role_id, position) VALUES (v_id, v_mini_rl, 0)
  ON CONFLICT (stage_id, role_id) DO NOTHING;

  -- 7.2 GLOBAL рёбра: intake→router; router→mini(small); router→arch(fallback);
  --      mini→programmer. Старое intake→architect убираем (его заменяет router).
  DELETE FROM global_stage_edges WHERE from_key = v_intake_key AND to_key = v_arch_key;
  INSERT INTO global_stage_edges (from_key, to_key, condition, position) VALUES
    (v_intake_key, v_router_key, NULL,    0),
    (v_router_key, v_mini_key,   'small', 0),
    (v_router_key, v_arch_key,   NULL,    1),
    (v_mini_key,   v_prog_key,   NULL,    0);

  -- 7.3 Бэкфилл дев-проектов (есть узел Architect; INFRA/иные исключены).
  FOR p IN
    SELECT DISTINCT ps.project_id AS pid
      FROM project_stages ps
      JOIN projects pr ON pr.id = ps.project_id
     WHERE ps.stage_key = v_arch_key
       AND pr.pipeline_kind IS DISTINCT FROM 'infrastructure'
  LOOP
    IF EXISTS (SELECT 1 FROM project_stages WHERE project_id = p.pid AND stage_key = v_router_key) THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(MAX(position), 0) + 1 INTO v_pos FROM project_stages WHERE project_id = p.pid;
    INSERT INTO project_stages (project_id, position, name, enabled, watch_directory, task_status, kind, stage_key, join_key)
    VALUES (p.pid, v_pos, 'Task Router', true, NULL, 'ARCHITECTURE'::task_status, 'stage', v_router_key, NULL)
    RETURNING id INTO v_id;
    INSERT INTO project_stage_roles (stage_id, role_id, position) VALUES (v_id, v_router_rl, 0)
    ON CONFLICT (stage_id, role_id) DO NOTHING;

    SELECT COALESCE(MAX(position), 0) + 1 INTO v_pos FROM project_stages WHERE project_id = p.pid;
    INSERT INTO project_stages (project_id, position, name, enabled, watch_directory, task_status, kind, stage_key, join_key)
    VALUES (p.pid, v_pos, 'Mini Architect', true, NULL, 'ARCHITECTURE'::task_status, 'stage', v_mini_key, NULL)
    RETURNING id INTO v_id;
    INSERT INTO project_stage_roles (stage_id, role_id, position) VALUES (v_id, v_mini_rl, 0)
    ON CONFLICT (stage_id, role_id) DO NOTHING;

    DELETE FROM project_stage_edges WHERE project_id = p.pid AND from_key = v_intake_key AND to_key = v_arch_key;
    INSERT INTO project_stage_edges (project_id, from_key, to_key, condition, position) VALUES
      (p.pid, v_intake_key, v_router_key, NULL,    0),
      (p.pid, v_router_key, v_mini_key,   'small', 0),
      (p.pid, v_router_key, v_arch_key,   NULL,    1),
      (p.pid, v_mini_key,   v_prog_key,   NULL,    0);
  END LOOP;
END $graph$;

COMMIT;

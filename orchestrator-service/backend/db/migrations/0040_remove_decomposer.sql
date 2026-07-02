-- =====================================================================
-- DECOMPOSER-REMOVE-001
-- Убрать Декомпозитора из «Схемы разработки» (граф-режим и линейный фолбэк).
--
-- Почему: пользователь принял решение отказаться от декомпозиции — цепочка
--   INTAKE -> ARCHITECT -> PROGRAMMER. Мультисервис делает одна задача (программист
--   берёт по одной, параллельность выключаем). Единственный ПОЛЕЗНЫЙ побочный эффект
--   Декомпозитора (проставить service_id материализованной подзадаче) переносится в
--   финализацию Архитектора в коде (см. db.js ensureArchitectService).
--
-- Роль DECOMPOSER в таблице roles НЕ удаляем (нужна для истории/agent_runs/KPI) —
-- только выводим из активной схемы (узел + рёбра). Все ключи узлов (stage_key)
-- одинаковы в global и во всех проектах, поэтому оперируем по stage_key Декомпозитора.
--
-- Идемпотентно: если Декомпозитора в схеме уже нет — блоки no-op.
-- =====================================================================
BEGIN;

-- --- Ключи узлов Декомпозитора из ГЛОБАЛЬНОЙ схемы (роль DECOMPOSER) ----------
-- Тот же stage_key зеркалится в project_stages всех проектов.
CREATE TEMP TABLE _dkeys ON COMMIT DROP AS
  SELECT DISTINCT gs.stage_key AS k
    FROM global_stages gs
    JOIN global_stage_roles gsr ON gsr.stage_id = gs.id
    JOIN roles r ON r.id = gsr.role_id
   WHERE r.code = 'DECOMPOSER' AND gs.stage_key IS NOT NULL;

-- =====================================================================
-- 1. GLOBAL: сшить рёбра A -> DECOMPOSER -> B в A -> B, затем убрать узел.
-- =====================================================================
INSERT INTO global_stage_edges (from_key, to_key, condition, position)
SELECT DISTINCT pin.from_key, pout.to_key, NULL, 0
  FROM global_stage_edges pin
  JOIN _dkeys d1 ON pin.to_key = d1.k
  JOIN global_stage_edges pout ON pout.from_key = pin.to_key
 WHERE pin.from_key <> pout.to_key
   AND NOT EXISTS (
     SELECT 1 FROM global_stage_edges g
      WHERE g.from_key = pin.from_key AND g.to_key = pout.to_key
   );

DELETE FROM global_stage_edges e
 WHERE e.from_key IN (SELECT k FROM _dkeys)
    OR e.to_key   IN (SELECT k FROM _dkeys);

DELETE FROM global_stage_roles gsr
 USING global_stages gs
 WHERE gsr.stage_id = gs.id
   AND gs.stage_key IN (SELECT k FROM _dkeys);

DELETE FROM global_stages gs
 WHERE gs.stage_key IN (SELECT k FROM _dkeys);

-- =====================================================================
-- 2. PROJECTS: то же по каждому проекту (рёбра — копия глобальных по ключам).
-- =====================================================================
INSERT INTO project_stage_edges (project_id, from_key, to_key, condition, position)
SELECT DISTINCT pin.project_id, pin.from_key, pout.to_key, NULL, 0
  FROM project_stage_edges pin
  JOIN _dkeys d1 ON pin.to_key = d1.k
  JOIN project_stage_edges pout
       ON pout.from_key = pin.to_key AND pout.project_id = pin.project_id
 WHERE pin.from_key <> pout.to_key
   AND NOT EXISTS (
     SELECT 1 FROM project_stage_edges g
      WHERE g.project_id = pin.project_id
        AND g.from_key = pin.from_key AND g.to_key = pout.to_key
   );

DELETE FROM project_stage_edges e
 WHERE e.from_key IN (SELECT k FROM _dkeys)
    OR e.to_key   IN (SELECT k FROM _dkeys);

DELETE FROM project_stage_roles psr
 USING project_stages ps
 WHERE psr.stage_id = ps.id
   AND ps.stage_key IN (SELECT k FROM _dkeys);

DELETE FROM project_stages ps
 WHERE ps.stage_key IN (SELECT k FROM _dkeys);

-- =====================================================================
-- 3. IN-FLIGHT задачи, зависшие на удаляемом этапе (status = DECOMPOSITION).
--    Решение пользователя: service/subtask -> переиграть Архитектора; epic -> ждать детей.
-- =====================================================================
-- Ключ узла Архитектора (для граф-режимных задач) из ГЛОБАЛЬНОЙ схемы.
CREATE TEMP TABLE _akey ON COMMIT DROP AS
  SELECT gs.stage_key AS k
    FROM global_stages gs
    JOIN global_stage_roles gsr ON gsr.stage_id = gs.id
    JOIN roles r ON r.id = gsr.role_id
   WHERE r.code = 'ARCHITECT' AND gs.stage_key IS NOT NULL
   LIMIT 1;

-- Собираем ФАКТИЧЕСКИ перемещённые задачи (RETURNING), чтобы событие истории
-- добавить ровно им, а не всем задачам, когда-либо проходившим DECOMPOSITION.
CREATE TEMP TABLE _moved (id uuid, kind text, to_status text) ON COMMIT DROP;

-- 3a. Не-эпики -> назад на ARCHITECT / ARCHITECTURE (Архитектор пройдёт заново и,
--     благодаря коду, гарантирует service_id перед CODING). Граф-режимным задачам
--     переставляем current_stage_key на узел Архитектора; линейным оставляем NULL.
WITH upd AS (
  UPDATE tasks t
     SET status = 'ARCHITECTURE',
         current_role_id = (SELECT id FROM roles WHERE code = 'ARCHITECT'),
         current_stage_key = CASE WHEN t.current_stage_key IS NOT NULL
                                  THEN (SELECT k FROM _akey)
                                  ELSE NULL END,
         assigned_agent_id = NULL
   WHERE t.status = 'DECOMPOSITION'
     AND t.task_kind <> 'epic'
  RETURNING t.id, t.task_kind
)
INSERT INTO _moved SELECT id, task_kind, 'ARCHITECTURE' FROM upd;

-- 3b. Эпики -> WAITING_FOR_CHILDREN (дети уже материализованы, роллап их подхватит).
WITH upd AS (
  UPDATE tasks t
     SET status = 'WAITING_FOR_CHILDREN',
         assigned_agent_id = NULL
   WHERE t.status = 'DECOMPOSITION'
     AND t.task_kind = 'epic'
  RETURNING t.id, t.task_kind
)
INSERT INTO _moved SELECT id, task_kind, 'WAITING_FOR_CHILDREN' FROM upd;

-- Хронология перевода (для «Истории задачи») — только реально перемещённым.
INSERT INTO task_events (task_id, event_type, to_status, role_id, payload_json)
SELECT m.id, 'STATUS_CHANGED', m.to_status::task_status,
       (SELECT id FROM roles WHERE code = 'ARCHITECT'),
       jsonb_build_object('migration', '0040_remove_decomposer',
                          'reason', 'decomposer_removed', 'task_kind', m.kind)
  FROM _moved m;

-- =====================================================================
-- 4. Промт Приёмщика: привести в соответствие с контрактом (short_title,
--    structured_description, project_understanding — уже required в role_fields, но
--    англ. промт 0038 их не запрашивал) и задействовать поданную инлайн карту проекта.
-- =====================================================================
CREATE TEMP TABLE _intake_prompt ON COMMIT DROP AS
SELECT $prompt$# Role: Task Intake Officer

## Purpose
You are the first role in the task pipeline. Convert the user's raw request into a precise, well-structured task card for routing. You receive the project map inline in context; use it to ground the project, service, and component. You do not read source files.

## Grounding Rules
- Use only the request, the provided context, and the project map.
- Do not invent projects, services, components, requirements, errors, files, APIs, or user intent.
- Expand and organize only what the user actually said. Every inference goes to `assumptions`, never presented as fact.
- If confidence for project, service, or component is below 70%, use `unknown`.
- Prefer a blocking question over a guessed requirement.

## Forbidden
Writing code, proposing a solution, designing architecture, decomposing into subtasks, choosing implementation technology, choosing the next role, editing files.

## Produce (all keys in `fields`)
- `short_title`: concise task name (<= 80 chars).
- `task_title`: clear one-line title.
- `structured_description`: the full, maximally detailed restatement of the request — goal, expected behavior, in/out of scope, constraints, and any acceptance signals the user stated. Organize it clearly. This is the primary hand-off to the Architect. Add no requirement the user did not state; inferences go to `assumptions`.
- `project_understanding`: how this task fits the project, based on the project map (which service/component area it likely touches). Map facts only; guesses go to `assumptions`.
- `task_type`: one or more of bugfix, feature, improvement, refactoring, optimization, frontend, backend, database, api, integration, security, devops, infrastructure, testing, documentation, analytics, migration, unknown.
- `project`, `service`, `component`: from the project map, or `unknown`.
- `user_goal`: the outcome the user wants, without proposing implementation.
- `original_request`: original meaning, preserving requirements and constraints.
- `confidence`: high | medium | low.
- `blocking_questions`, `optional_questions`: lists (empty if none).
- `assumptions`: inferences drawn from context (empty if none).

## Output
Return role status `READY` when the task can be routed without blocking questions, `BLOCKED` when user input is required.
$prompt$ AS prompt;

UPDATE roles r
   SET prompt = p.prompt
  FROM _intake_prompt p
 WHERE r.code = 'TASK_INTAKE_OFFICER'
   AND r.prompt IS DISTINCT FROM p.prompt;

-- Версионирование промта (как в 0038): деактивировать старую активную версию и
-- завести новую активную, если текст изменился.
UPDATE prompts old
   SET is_active = false
  FROM roles r, _intake_prompt p
 WHERE old.role_id = r.id
   AND r.code = 'TASK_INTAKE_OFFICER'
   AND old.is_active = true
   AND old.prompt_text IS DISTINCT FROM p.prompt;

INSERT INTO prompts (role_id, version, prompt_text, is_active, content_hash, label, author)
SELECT r.id,
       COALESCE((SELECT max(version) FROM prompts WHERE role_id = r.id), 0) + 1,
       p.prompt,
       true,
       encode(digest(p.prompt, 'sha256'), 'hex'),
       'intake-map-and-structured-description',
       'migration:0040'
  FROM roles r, _intake_prompt p
 WHERE r.code = 'TASK_INTAKE_OFFICER'
   AND NOT EXISTS (
     SELECT 1 FROM prompts active
      WHERE active.role_id = r.id
        AND active.is_active = true
        AND active.prompt_text = p.prompt
   );

-- =====================================================================
-- 5. Выключить параллельность программиста (одна задача за раз).
-- =====================================================================
INSERT INTO app_settings (key, value)
VALUES ('programmer_concurrency', '1'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = '1'::jsonb;

COMMIT;

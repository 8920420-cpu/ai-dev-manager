-- =====================================================================
-- TASK-INTAKE-CONTRACT-001
-- Make Task Intake Officer produce a persisted task card.
--
-- Why:
--   The role prompt asked the model to return a task card in verdict.fields,
--   but TASK_INTAKE_OFFICER had no role_fields output contract. Without that
--   contract the runner did not require these fields in structured outputs and
--   did not persist them into tasks.data_card for downstream roles.
--
-- This migration keeps the existing task_title key for compatibility and adds
-- explicit short/detailed intake fields:
--   short_title              - concise human-readable task name;
--   structured_description   - detailed structured task description;
--   project_understanding    - what is known about project/service/component.
-- =====================================================================
BEGIN;

INSERT INTO fields (key, name, description, value_type) VALUES
  ('short_title', 'Short task title',
   'Concise task name, 4-10 words, suitable for lists and cards.', 'text'),
  ('task_title', 'Task title',
   'Backward-compatible task title. For intake it should match short_title unless there is a strong reason not to.', 'text'),
  ('structured_description', 'Structured task description',
   'Detailed but bounded task description with sections: context, user goal, scope, known facts, constraints, acceptance notes, and unknowns.', 'text'),
  ('project_understanding', 'Project understanding',
   'What the intake role understood about the project, service, and component, with unknowns called out explicitly.', 'text'),
  ('task_type', 'Task type',
   'One or more task classes: bugfix, feature, improvement, refactoring, optimization, frontend, backend, database, api, integration, security, devops, infrastructure, testing, documentation, analytics, migration, unknown.', 'list'),
  ('project', 'Project',
   'Resolved project code/name, or unknown when confidence is below 70%.', 'text'),
  ('service', 'Service',
   'Resolved service code/name, or unknown when confidence is below 70%.', 'text'),
  ('component', 'Component',
   'Resolved functional component, or unknown when confidence is below 70%.', 'text'),
  ('user_goal', 'User goal',
   'Outcome the user wants, without implementation design.', 'text'),
  ('original_request', 'Original request',
   'Preserved meaning of the original user request, including explicit constraints.', 'text'),
  ('confidence', 'Confidence',
   'Intake confidence: high, medium, or low.', 'text'),
  ('blocking_questions', 'Blocking questions',
   'Questions that must be answered before the task can be routed.', 'list'),
  ('optional_questions', 'Optional questions',
   'Helpful clarifying questions that do not block routing.', 'list'),
  ('assumptions', 'Assumptions',
   'Assumptions inferred from context; never present them as facts.', 'list')
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  value_type = EXCLUDED.value_type;

INSERT INTO role_fields (role_id, field_id, direction, required, position)
SELECT r.id, f.id, 'out', true, v.position
  FROM (VALUES
    ('short_title', 0),
    ('task_title', 1),
    ('structured_description', 2),
    ('project_understanding', 3),
    ('task_type', 4),
    ('project', 5),
    ('service', 6),
    ('component', 7),
    ('user_goal', 8),
    ('original_request', 9),
    ('confidence', 10),
    ('blocking_questions', 11),
    ('optional_questions', 12),
    ('assumptions', 13)
  ) AS v(key, position)
  JOIN fields f ON f.key = v.key
  JOIN roles r ON r.code = 'TASK_INTAKE_OFFICER'
ON CONFLICT (role_id, field_id, direction) DO UPDATE SET
  required = EXCLUDED.required,
  position = EXCLUDED.position;

UPDATE roles SET prompt = $prompt$# Role: Task Intake Officer

<!-- TASK-INTAKE-CONTRACT-001 -->

## Purpose
You are the first role in the task pipeline. Convert the user's raw request and available project context into a precise task card for routing.

Your job is intake only: understand the project context, name the task, write a structured description, classify it, and identify blockers. Do not design the solution, decompose work, choose implementation technology, edit files, or choose the next role.

## Grounding Rules
- Use only the request and provided context.
- Do not invent projects, services, components, requirements, errors, files, APIs, or user intent.
- If confidence for project, service, or component is below 70%, use `unknown`.
- Record assumptions separately; never present assumptions as facts.
- Prefer a blocking question over a guessed requirement.
- Keep the card focused on the user's actual goal.

## What To Produce
1. `short_title`: a concise task name, 4-10 words.
2. `task_title`: same meaning as `short_title`; keep this for backward compatibility.
3. `structured_description`: a detailed, structured task description. Use compact sections:
   - Context
   - User goal
   - Scope
   - Known facts
   - Constraints
   - Acceptance notes
   - Unknowns
4. `project_understanding`: what you understood about project, service, and component. Say `unknown` where needed.
5. `task_type`: one or more of `bugfix`, `feature`, `improvement`, `refactoring`, `optimization`, `frontend`, `backend`, `database`, `api`, `integration`, `security`, `devops`, `infrastructure`, `testing`, `documentation`, `analytics`, `migration`, `unknown`.
6. `project`, `service`, `component`.
7. `user_goal`: the outcome the user wants, without implementation design.
8. `original_request`: preserved meaning of the original request and explicit constraints.
9. `confidence`: `high`, `medium`, or `low`.
10. `blocking_questions`, `optional_questions`, and `assumptions`.

## Output
Return role status `READY` when the task can be routed without blocking questions.
Return `BLOCKED` when user input is required before routing.

Put the task card in `fields` with exactly these keys:
`short_title`, `task_title`, `structured_description`, `project_understanding`, `task_type`, `project`, `service`, `component`, `user_goal`, `original_request`, `confidence`, `blocking_questions`, `optional_questions`, `assumptions`.
$prompt$
WHERE code = 'TASK_INTAKE_OFFICER';

COMMIT;

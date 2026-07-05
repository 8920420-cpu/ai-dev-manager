-- =====================================================================
-- INTAKE-OFFICER-PRIORITY-001 — поле priority в контракте Приёмщика задач.
--
-- Продолжение TASK-PRIORITY-SCALE-001 (миграция 0047). Приёмщик/Постановщик
-- обязан расставлять пользовательский приоритет по критичности:
--   1 — деградация конвейера / блокер многих задач (максимальный);
--   2 — обычная фича/багфикс (дефолт);
--   3 — косметика/документация (низкий).
-- Значение 0 роль/клиент НЕ ставит — его форсит сервер для проекта оркестратора.
--
-- Дополняет: (1) справочник fields ключом priority; (2) выходной контракт роли
-- (role_fields, direction=out, необязательное поле); (3) пайплайновый промт роли
-- (guard-marker по образцу 0045 — повторный накат текст не дублирует).
-- =====================================================================
BEGIN;

-- 1. Справочник полей: ключ priority.
INSERT INTO fields (key, name, description, value_type) VALUES
  ('priority', 'Task priority',
   'User-facing task priority: 1 = highest user priority (pipeline degradation or a blocker of many tasks), 2 = normal feature/bugfix (default), 3 = low (cosmetics/docs). Value 0 is reserved for the orchestrator project (PROJECT / ai-dev-manager) and is forced by the server; the role and the client never set it.', 'text')
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  value_type = EXCLUDED.value_type;

-- 2. Выходной контракт роли: priority — необязательное поле (дефолт применит сервер).
INSERT INTO role_fields (role_id, field_id, direction, required, position)
SELECT r.id, f.id, 'out', false, 14
  FROM fields f
  JOIN roles r ON r.code = 'TASK_INTAKE_OFFICER'
 WHERE f.key = 'priority'
ON CONFLICT (role_id, field_id, direction) DO UPDATE SET
  required = EXCLUDED.required,
  position = EXCLUDED.position;

-- 3. Пайплайновый промт роли — дополняем один раз (идемпотентно, guard-marker).
UPDATE roles SET prompt = prompt || $intake$

<!-- INTAKE-OFFICER-PRIORITY-001 -->

## Task priority
Add a `priority` key to the task card: an integer `1`-`3` (default `2`). Choose it by criticality:
- `1` — a pipeline degradation or a blocker of many tasks (highest user priority);
- `2` — a normal feature or bugfix (the default);
- `3` — cosmetics or documentation (low).

Never set `0`: priority `0` is reserved for the orchestrator project (PROJECT / ai-dev-manager) and is forced by the server automatically. Neither the role nor the client assigns `0`, and the client cannot set `0` on any other project's task (the server normalizes it to `1`).
$intake$
 WHERE code = 'TASK_INTAKE_OFFICER'
   AND prompt IS NOT NULL
   AND prompt NOT LIKE '%INTAKE-OFFICER-PRIORITY-001%';

COMMIT;

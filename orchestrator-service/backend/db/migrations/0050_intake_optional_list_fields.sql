-- =====================================================================
-- INTAKE-OPTIONAL-LISTS-001 — списочные поля приёмщика сделать необязательными.
-- Идемпотентная миграция (повторный запуск безопасен).
-- =====================================================================
-- 0040 (TASK-INTAKE-CONTRACT-001) объявила ВСЕ исходящие поля TASK_INTAKE_OFFICER
-- required=true, включая списки blocking_questions / optional_questions /
-- assumptions. Но по промту роли пустой список — ЛЕГИТИМНЫЙ ответ («если
-- вопросов нет — пустые списки»), а isFilled([]) = false. Итог: у задачи без
-- блокирующих вопросов сдача получала missing_outputs:blocking_questions →
-- decision REWORK, а REWORK первой роли маршрута ведёт в неё же саму
-- (reworkTarget → firstStep) — задача вечно крутилась BACKLOG→BACKLOG,
-- сжигая прогон LLM каждые ~40 секунд.
--
-- Списки, для которых «пусто» — нормальный исход, обязательными быть не могут.
-- =====================================================================

BEGIN;

UPDATE role_fields rf
   SET required = false
  FROM roles r, fields f
 WHERE rf.role_id = r.id
   AND rf.field_id = f.id
   AND r.code = 'TASK_INTAKE_OFFICER'
   AND rf.direction = 'out'
   AND f.key IN ('blocking_questions', 'optional_questions', 'assumptions');

COMMIT;

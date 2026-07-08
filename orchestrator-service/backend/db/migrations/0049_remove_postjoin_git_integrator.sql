-- =====================================================================
-- REMOVE-POSTJOIN-GI-001 — убрать пост-join этап «Git Integrator (документация)».
-- Идемпотентная миграция (повторный запуск безопасен).
-- =====================================================================
-- Этап добавляла 0046 (DOC-COMMIT-ON-JOIN-001, часть 2). Решение: Git Integrator
-- выполняется ПАРАЛЛЕЛЬНО Documentation Auditor/Keeper внутри fork-ветки, второй
-- прогон Git Integrator после join избыточен — узел и его рёбра удаляются из
-- глобальной схемы и материализованных проектов.
--
-- После удаления join снова терминален: advanceJoinNodes при отсутствии
-- исходящего ребра завершает родителя в DONE (штатный путь до 0046).
-- Часть 1 из 0046 (исходящее поле changedFiles у Documentation Keeper и его
-- агрегация в событии join) СОХРАНЯЕТСЯ — убирается только этап-потребитель.
--
-- Спасение: нетерминальные задачи, стоящие ровно на удаляемом узле (после него
-- рёбер нет — маршрут кончался), завершаются в DONE с событием журнала.
-- =====================================================================

BEGIN;

-- 1. Дозавершить задачи, припаркованные на удаляемом узле (иначе осиротеют:
--    claim не увидит роль исчезнувшего узла). На момент написания таких нет.
INSERT INTO task_events (task_id, event_type, from_status, to_status, role_id, payload_json)
SELECT t.id, 'TASK_DONE', t.status, 'DONE'::task_status, t.current_role_id,
       jsonb_build_object('migration', '0049_remove_postjoin_git_integrator',
                          'reason', 'postjoin_node_removed')
  FROM tasks t
 WHERE t.current_stage_key = 'd0c0d0c0-0000-4000-8000-000000000001'
   AND t.status::text NOT IN ('DONE', 'CANCELLED', 'FAILED');

UPDATE tasks
   SET status = 'DONE'::task_status, current_role_id = NULL,
       current_stage_key = NULL, assigned_agent_id = NULL, updated_at = now()
 WHERE current_stage_key = 'd0c0d0c0-0000-4000-8000-000000000001'
   AND status::text NOT IN ('DONE', 'CANCELLED', 'FAILED');

-- 2. Рёбра узла (FK на stage_key нет — удаляем явно), затем сами узлы;
--    global_stage_roles/project_stage_roles уходят каскадом по stage_id.
DELETE FROM global_stage_edges
 WHERE from_key = 'd0c0d0c0-0000-4000-8000-000000000001'
    OR to_key   = 'd0c0d0c0-0000-4000-8000-000000000001';

DELETE FROM project_stage_edges
 WHERE from_key = 'd0c0d0c0-0000-4000-8000-000000000001'
    OR to_key   = 'd0c0d0c0-0000-4000-8000-000000000001';

DELETE FROM project_stages WHERE stage_key = 'd0c0d0c0-0000-4000-8000-000000000001';
DELETE FROM global_stages  WHERE stage_key = 'd0c0d0c0-0000-4000-8000-000000000001';

COMMIT;

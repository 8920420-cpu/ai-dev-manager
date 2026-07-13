-- =====================================================================
-- RESTORE-POSTJOIN-GI-001 — вернуть пост-join этап «Git Integrator (документация)».
-- Идемпотентная миграция (повторный запуск безопасен).
-- =====================================================================
-- Узел добавляла 0046 (DOC-COMMIT-ON-JOIN-001), 0049 его удалила как «избыточный».
-- На практике избыточным он не был: fork-ветка Git Integrator коммитит КОД (cherry-pick
-- дельты программиста) и завершается МГНОВЕННО, а Documentation Keeper дописывает
-- docs/*.md в рабочее дерево main ПОЗЖЕ и на СОСЕДНЕЙ ветке — эти правки остаются
-- НЕзакоммиченными в main. Они (а) теряются как доставка и (б) грязнят main, из-за чего
-- следующая задача упирается в dirty_worktree_conflict при cherry-pick. Инцидент 13.07:
-- доки задачи 293410c3 (HR/Salary_Service/README.md, PROJECT_MAP.md) висели в main.
--
-- Решение: после схождения fork-веток (JOIN) родитель едет на отдельный Git Integrator,
-- который стейджит+коммитит+пушит именно doc-пути. Логика РАНТАЙМА уже готова и НЕ
-- удалялась 0049 (Часть 1 из 0046 сохранена): advanceJoinNodes агрегирует changedFiles
-- детей (Doc Keeper) и выносит их верхним уровнем в событие продвижения родителя;
-- resolveHostTaskContext их подхватывает; runGitAction (integrateChangedFiles) коммитит.
-- Не хватало только самого узла + ребра JOIN→узел — их и возвращаем. При пустых
-- changedFiles (Doc Auditor→NO_CHANGES) узел упрётся в nothing_to_stage — второго
-- коммита не будет (поведение как без узла).
--
-- Идемпотентно: фиксированный stage_key; при уже существующем узле — no-op; join не
-- расширяем, если у него уже есть исходящее ребро (кастомный пост-join маршрут).
-- =====================================================================

BEGIN;

DO $$
DECLARE
  v_join_key uuid;
  v_new_key  uuid := 'd0c0d0c0-0000-4000-8000-000000000001';
  v_gi_role  uuid;
  v_new_id   uuid;
  v_pos      int;
  p          record;
BEGIN
  SELECT id INTO v_gi_role FROM roles WHERE code = 'GIT_INTEGRATOR';
  IF v_gi_role IS NULL THEN RETURN; END IF;

  -- Идемпотентность: узел уже возвращён ранее.
  IF EXISTS (SELECT 1 FROM global_stages WHERE stage_key = v_new_key) THEN RETURN; END IF;

  -- Линейные проекты (без fork/join) не трогаем.
  SELECT stage_key INTO v_join_key FROM global_stages
   WHERE kind = 'join' ORDER BY position LIMIT 1;
  IF v_join_key IS NULL THEN RETURN; END IF;

  -- Не расширяем join, если у него уже есть исходящее ребро (кастомный пост-join маршрут).
  IF EXISTS (SELECT 1 FROM global_stage_edges WHERE from_key = v_join_key) THEN RETURN; END IF;

  -- 1. Узел пост-join Git Integrator в единой схеме (слой авторинга).
  SELECT COALESCE(MAX(position), 0) + 1 INTO v_pos FROM global_stages;
  INSERT INTO global_stages (position, name, enabled, task_status, kind, stage_key, join_key)
  VALUES (v_pos, 'Git Integrator (документация)', true, 'COMMIT'::task_status, 'stage', v_new_key, NULL)
  RETURNING id INTO v_new_id;
  INSERT INTO global_stage_roles (stage_id, role_id, position)
  VALUES (v_new_id, v_gi_role, 0)
  ON CONFLICT (stage_id, role_id) DO NOTHING;
  INSERT INTO global_stage_edges (from_key, to_key, condition, position)
  VALUES (v_join_key, v_new_key, NULL, 0);

  -- 2. Бэкфилл материализованных проектов (у которых есть тот же join-узел): узел +
  --    роль + ребро join→узел по одному разу на проект.
  FOR p IN
    SELECT DISTINCT project_id AS pid FROM project_stages WHERE stage_key = v_join_key
  LOOP
    IF EXISTS (SELECT 1 FROM project_stages WHERE project_id = p.pid AND stage_key = v_new_key) THEN
      CONTINUE;
    END IF;
    -- И не расширяем join проекта, если у него уже есть исходящее ребро.
    IF EXISTS (SELECT 1 FROM project_stage_edges WHERE project_id = p.pid AND from_key = v_join_key) THEN
      CONTINUE;
    END IF;
    SELECT COALESCE(MAX(position), 0) + 1 INTO v_pos FROM project_stages WHERE project_id = p.pid;
    INSERT INTO project_stages
      (project_id, position, name, enabled, watch_directory, task_status, kind, stage_key, join_key)
    VALUES
      (p.pid, v_pos, 'Git Integrator (документация)', true, NULL, 'COMMIT'::task_status,
       'stage', v_new_key, NULL)
    RETURNING id INTO v_new_id;
    INSERT INTO project_stage_roles (stage_id, role_id, position)
    VALUES (v_new_id, v_gi_role, 0)
    ON CONFLICT (stage_id, role_id) DO NOTHING;
    INSERT INTO project_stage_edges (project_id, from_key, to_key, condition, position)
    VALUES (p.pid, v_join_key, v_new_key, NULL, 0);
  END LOOP;
END $$;

COMMIT;

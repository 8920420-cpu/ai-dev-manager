-- =====================================================================
-- DOC-COMMIT-ON-JOIN-001 — правки документации (Doc Keeper) должны коммититься.
-- Идемпотентная миграция (повторный запуск безопасен).
-- =====================================================================
-- Проблема (инцидент f43a9f6c): FORK_GATE спавнит параллельные ветки
-- «документация» (Doc Auditor → Doc Keeper) и «git» (Git Integrator). Ветка git
-- завершается мгновенно и коммитит КОД, а Doc Keeper дописывает docs/*.md ПОЗЖЕ —
-- к этому моменту git-ветка уже отработала, правки доков остаются незакоммичены.
--
-- Решение (Вариант Б, аддитивно):
--   1) Doc Keeper получает ИСХОДЯЩЕЕ поле контракта `changedFiles` — список
--      отредактированных им файлов попадает в data_card док-ребёнка (раньше нигде
--      не персистился). advanceJoinNodes агрегирует их в событие продвижения
--      родителя (см. db.js DOC-COMMIT-ON-JOIN-001).
--   2) В граф fork/join добавляется узел Git Integrator ПОСЛЕ JOIN_GATE. После
--      схождения веток родитель едет на него и подбирает правки доков отдельным
--      коммитом. changedFiles уже закоммиченного кода git не пере-стейджит
--      (nothing_to_stage) → второго коммита при NO_CHANGES не будет.
--
-- Read-only аудит до миграции: поля `changedFiles` в fields нет (создаётся);
-- контракта DOCUMENTATION_KEEPER (out) по нему нет (создаётся); узла с фиксированным
-- stage_key нет (создаётся) — существующие данные не изменяются деструктивно.
-- =====================================================================

BEGIN;

-- --- 1. Поле карточки `changedFiles` + контракт Documentation Keeper (out) -----
INSERT INTO fields (key, name, description, value_type) VALUES
  ('changedFiles', 'Changed files',
   'Repository-relative paths edited by the role, for the Git Integrator to stage and commit.',
   'list')
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name, description = EXCLUDED.description, value_type = EXCLUDED.value_type;

-- Необязательное (required=false) исходящее поле: Doc Keeper сдаёт список
-- отредактированных документов; при NO_CHANGES список пуст — контракт не блокирует.
INSERT INTO role_fields (role_id, field_id, direction, required, position)
SELECT r.id, f.id, 'out', false, 100
  FROM fields f
  JOIN roles r ON r.code = 'DOCUMENTATION_KEEPER'
 WHERE f.key = 'changedFiles'
ON CONFLICT (role_id, field_id, direction) DO UPDATE SET
  required = EXCLUDED.required, position = EXCLUDED.position;

-- Подсказать модели заполнять changedFiles путями отредактированных доков.
-- Идемпотентно: маркер DOC-COMMIT-ON-JOIN-001 не даёт дописать дважды, приписываем
-- к тексту (не перезаписываем промпт — пользовательские правки не теряются).
UPDATE roles
   SET prompt = prompt || E'\n\n<!-- DOC-COMMIT-ON-JOIN-001 -->\n## Changed files\n'
     || E'Also return `changedFiles`: the exact repository-relative paths of the '
     || E'documentation files you edited (the same set as `updated_documents`). '
     || E'The Git Integrator stages and commits exactly these paths.\n'
 WHERE code = 'DOCUMENTATION_KEEPER'
   AND prompt IS NOT NULL
   AND prompt NOT LIKE '%DOC-COMMIT-ON-JOIN-001%';

-- --- 2. Узел Git Integrator ПОСЛЕ JOIN_GATE (граф fork/join) -------------------
-- Только для fork/join-схемы (есть join-узел) и только если join сейчас терминален
-- (нет исходящего ребра → родитель уходил в DONE). Фиксированный stage_key делает
-- миграцию идемпотентной и позволяет бэкфиллить уже материализованные проекты.
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

  -- Идемпотентность: узел уже добавлен ранее.
  IF EXISTS (SELECT 1 FROM global_stages WHERE stage_key = v_new_key) THEN RETURN; END IF;

  -- Линейные проекты (без fork/join) не трогаем.
  SELECT stage_key INTO v_join_key FROM global_stages
   WHERE kind = 'join' ORDER BY position LIMIT 1;
  IF v_join_key IS NULL THEN RETURN; END IF;

  -- Не расширяем join, если у него уже есть исходящее ребро (кастомный пост-join
  -- маршрут) — чтобы не сломать существующую конфигурацию.
  IF EXISTS (SELECT 1 FROM global_stage_edges WHERE from_key = v_join_key) THEN RETURN; END IF;

  -- 2a. Узел пост-join Git Integrator в единой схеме (слой авторинга).
  SELECT COALESCE(MAX(position), 0) + 1 INTO v_pos FROM global_stages;
  INSERT INTO global_stages (position, name, enabled, task_status, kind, stage_key, join_key)
  VALUES (v_pos, 'Git Integrator (документация)', true, 'COMMIT'::task_status, 'stage', v_new_key, NULL)
  RETURNING id INTO v_new_id;
  INSERT INTO global_stage_roles (stage_id, role_id, position)
  VALUES (v_new_id, v_gi_role, 0)
  ON CONFLICT (stage_id, role_id) DO NOTHING;
  INSERT INTO global_stage_edges (from_key, to_key, condition, position)
  VALUES (v_join_key, v_new_key, NULL, 0);

  -- 2b. Бэкфилл уже материализованных проектов (у которых есть тот же join-узел):
  --     узел + роль + ребро join→узел добавляем по одному разу на проект.
  FOR p IN
    SELECT DISTINCT project_id AS pid FROM project_stages WHERE stage_key = v_join_key
  LOOP
    IF EXISTS (SELECT 1 FROM project_stages WHERE project_id = p.pid AND stage_key = v_new_key) THEN
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

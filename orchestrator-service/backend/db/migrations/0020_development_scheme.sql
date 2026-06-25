-- =====================================================================
-- DEVELOPMENT-SCHEME-001 — единая «Схема разработки» для всех проектов.
-- Идемпотентная миграция (повторный запуск безопасен).
-- =====================================================================
-- Этапы пайплайна (порядок ролей, по которому движется задача) больше не
-- настраиваются для каждого проекта по отдельности — это ОДИН общий конвейер.
-- Глобальная схема хранится в global_stages/global_stage_roles и материализуется
-- в project_stages каждого проекта при создании проекта и при сохранении схемы
-- (см. developmentScheme.js). Поэтому весь runner-код (db.js), читающий
-- project_stages по project_id, остаётся без изменений.
--
-- В отличие от project_stages у глобальной схемы НЕТ watch_directory: папку
-- Scanner каждый проект задаёт своей «папкой документов» (projects.docs_path),
-- которая подставляется в project_stages.watch_directory при материализации.
-- =====================================================================

BEGIN;

-- Папка с документами проекта («карта» проекта: файлы, описывающие проект и его
-- микросервисы). Её же отслеживает Scanner этого проекта. Абсолютный путь; NULL —
-- папка не задана. Существование каталога проверяет scanner-service.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS docs_path text;
COMMENT ON COLUMN projects.docs_path IS
  'Абсолютный путь к папке документов проекта. Подставляется в watch_directory Scanner-этапа.';

-- Этапы единой схемы разработки (упорядоченный список, общий для всех проектов).
CREATE TABLE IF NOT EXISTS global_stages (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    position    int  NOT NULL,
    name        text NOT NULL,
    enabled     boolean NOT NULL DEFAULT true,
    -- Статус задач этапа (task_status): по нему резолвер маршрута ведёт задачу.
    task_status task_status,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (position)
);
COMMENT ON TABLE global_stages IS
  'Единая схема разработки: порядок этапов и их статусы. Общая для всех проектов.';

-- Роли, назначенные этапу единой схемы. Код роли SCANNER — единственный признак
-- Scanner-этапа.
CREATE TABLE IF NOT EXISTS global_stage_roles (
    stage_id uuid NOT NULL REFERENCES global_stages(id) ON DELETE CASCADE,
    role_id  uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    position int  NOT NULL DEFAULT 0,
    PRIMARY KEY (stage_id, role_id)
);
COMMENT ON TABLE global_stage_roles IS
  'Назначение ролей этапу единой схемы (M:N). Scanner определяется кодом роли SCANNER.';

CREATE INDEX IF NOT EXISTS idx_global_stage_roles_role_id ON global_stage_roles(role_id);

DROP TRIGGER IF EXISTS global_stages_set_updated_at ON global_stages;
CREATE TRIGGER global_stages_set_updated_at
    BEFORE UPDATE ON global_stages
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- Сид: если схема ещё пуста, переносим в неё этапы из наиболее полно настроенного
-- существующего проекта (сохраняем текущий конвейер). watch_directory не копируем —
-- папку Scanner теперь задаёт docs_path каждого проекта. Идемпотентно: при
-- повторном запуске global_stages уже не пуста и сид пропускается.
INSERT INTO global_stages (id, position, name, enabled, task_status)
SELECT ps.id, ps.position, ps.name, ps.enabled, ps.task_status
  FROM project_stages ps
 WHERE NOT EXISTS (SELECT 1 FROM global_stages)
   AND ps.project_id = (
        SELECT project_id FROM project_stages
         GROUP BY project_id ORDER BY count(*) DESC, project_id LIMIT 1
   );

INSERT INTO global_stage_roles (stage_id, role_id, position)
SELECT psr.stage_id, psr.role_id, psr.position
  FROM project_stage_roles psr
 WHERE psr.stage_id IN (SELECT id FROM global_stages)
ON CONFLICT (stage_id, role_id) DO NOTHING;

COMMIT;

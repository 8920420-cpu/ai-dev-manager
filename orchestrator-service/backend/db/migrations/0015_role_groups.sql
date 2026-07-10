-- =====================================================================
-- ROLE-GROUPS-001 — смысловые группы ролей.
--
-- Роли в разделе «Настройки → Роли» раскладываются по управляемым смысловым
-- группам (кодеры, тестировщики и т. п.). Группа — самостоятельная сущность:
-- её можно создать, переименовать и удалить. Роль ссылается на группу через
-- roles.group_id; при удалении группы её роли возвращаются в «без группы»
-- (group_id = NULL, в UI — «Прочее»). Раскладка по группам НИКАК не влияет на
-- рантайм пайплайна — это только организация экрана ролей.
--
-- Глобальный флаг roles.hidden больше не используется ни в UI, ни в рантайме
-- (пропуск роли теперь настраивается per-project через project_stages.enabled,
-- см. «Этапы пайплайна» проекта). Колонку roles.hidden оставляем как есть ради
-- совместимости со старыми данными — её просто никто не читает.
-- =====================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS role_groups (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    sort_order int  NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Имя группы уникально без учёта регистра (нельзя две «Разработка»).
CREATE UNIQUE INDEX IF NOT EXISTS role_groups_name_lower_uidx
    ON role_groups (lower(name));

ALTER TABLE roles
    ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES role_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_roles_group_id ON roles(group_id);

-- Базовые группы (идемпотентно по имени). Существующие установки получают
-- стартовую раскладку; пользователь волен переименовать/удалить/создать свои.
INSERT INTO role_groups (name, sort_order) VALUES
    ('Аналитика и планирование', 10),
    ('Разработка',               20),
    ('Контроль качества',        30),
    ('Документация и структура', 40),
    ('Интеграция и доставка',    50)
ON CONFLICT (lower(name)) DO NOTHING;

-- Бэкафилл существующих ролей: проставляем группу только там, где её ещё нет,
-- чтобы не перетирать раскладку, изменённую пользователем. Неизвестные/
-- пользовательские роли остаются без группы (Прочее).
UPDATE roles r SET group_id = g.id
  FROM role_groups g
 WHERE r.group_id IS NULL
   AND g.name = CASE r.code
     WHEN 'ARCHITECT'             THEN 'Аналитика и планирование'
     WHEN 'DECOMPOSER'            THEN 'Аналитика и планирование'
     WHEN 'PROGRAMMER'            THEN 'Разработка'
     WHEN 'SCANNER'               THEN 'Разработка'
     WHEN 'TASK_REVIEWER'         THEN 'Контроль качества'
     WHEN 'PIPELINE_SERVICE'      THEN 'Контроль качества'
     WHEN 'FAILURE_ANALYST'       THEN 'Контроль качества'
     WHEN 'DOCUMENTATION_AUDITOR' THEN 'Документация и структура'
     WHEN 'DOCUMENTATION_KEEPER'  THEN 'Документация и структура'
     WHEN 'STRUCTURE_KEEPER'      THEN 'Документация и структура'
     WHEN 'GIT_INTEGRATOR'        THEN 'Интеграция и доставка'
     ELSE NULL
   END;

COMMIT;

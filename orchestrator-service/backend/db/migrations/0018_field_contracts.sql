-- =====================================================================
-- ROLE-FIELD-CONTRACT-001 — контракт данных ролей + карточка данных задачи.
--
--   * fields            — глобальный справочник полей (источник «существующих
--                         полей» для кнопки «Добавить» в модалке роли);
--   * role_fields       — контракт роли: какие поля роль ПРИНИМАЕТ (in) и какие
--                         ПРОИЗВОДИТ (out); контракт НЕОБЯЗАТЕЛЕН (роль без полей
--                         работает как сквозной проход);
--   * tasks.data_card   — персистентная кумулятивная карточка значений полей
--                         задачи (накапливается с первой роли, не сбрасывается);
--   * projects.pause_reason — текст причины паузы проекта (status='paused'),
--                         когда контракт роли изменён и требуется пересогласование.
--
-- Read-only аудит перед миграцией (2026-06-23):
--   fields / role_fields — таблиц нет (to_regclass = NULL), создаются с нуля.
--   tasks.data_card — колонки нет, добавляется NOT NULL DEFAULT '{}' (новая,
--     существующие 13 строк получают пустую карточку — данные не теряются).
--   projects.pause_reason — колонки нет, добавляется NULL.
-- Идемпотентно: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- =====================================================================
BEGIN;

-- --- Глобальный справочник полей ------------------------------------------
CREATE TABLE IF NOT EXISTS fields (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Машинный ключ поля в карточке задачи (стабильный, уникальный).
    key         text NOT NULL UNIQUE,
    name        text NOT NULL,
    description text,
    -- Тип-метаданные (text|number|list|json|boolean). Валидатор проверяет
    -- «заполнено», а не тип — тип носит справочный характер для UI.
    value_type  text NOT NULL DEFAULT 'text',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE fields IS
  'Глобальный справочник полей карточки задачи (ROLE-FIELD-CONTRACT-001).';

-- --- Контракт роли: входящие/исходящие поля --------------------------------
CREATE TABLE IF NOT EXISTS role_fields (
    role_id   uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    field_id  uuid NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
    -- Направление: 'in' — роль требует поле на входе; 'out' — роль его заполняет.
    direction text NOT NULL CHECK (direction IN ('in', 'out')),
    -- Обязательность участвует в валидаторе согласованности и runtime-проверке.
    required  boolean NOT NULL DEFAULT true,
    position  int NOT NULL DEFAULT 0,
    PRIMARY KEY (role_id, field_id, direction)
);
COMMENT ON TABLE role_fields IS
  'Контракт данных роли: какие поля роль принимает (in) и производит (out). '
  'Контракт необязателен — роль без записей работает как сквозной проход.';

CREATE INDEX IF NOT EXISTS idx_role_fields_role  ON role_fields(role_id);
CREATE INDEX IF NOT EXISTS idx_role_fields_field ON role_fields(field_id);

DROP TRIGGER IF EXISTS fields_set_updated_at ON fields;
CREATE TRIGGER fields_set_updated_at
    BEFORE UPDATE ON fields
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- --- Карточка данных задачи -------------------------------------------------
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS data_card jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN tasks.data_card IS
  'Персистентная кумулятивная карточка значений полей задачи {key: value}. '
  'Заполняется ролями по ходу маршрута, downstream-ролям доступны все ранее '
  'заполненные поля (значение не сбрасывается промежуточными ролями).';

-- --- Причина паузы проекта --------------------------------------------------
ALTER TABLE projects ADD COLUMN IF NOT EXISTS pause_reason text;
COMMENT ON COLUMN projects.pause_reason IS
  'Текст причины паузы (status=paused), напр. изменён контракт роли — нужно '
  'пересогласовать поля этапов проекта (ROLE-FIELD-CONTRACT-001).';

COMMIT;

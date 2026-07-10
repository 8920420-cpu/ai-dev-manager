-- =====================================================================
-- LEGACY-BUSINESS-STORAGE-API-001 — серверное хранение бизнес-данных,
-- ранее лежавших в localStorage фронтенда: статус/выбор БД проекта,
-- дополнительные подключения к БД и назначения «роль → коннектор».
-- Идемпотентная миграция (повторный запуск безопасен).
--
-- Сервер становится единственным источником истины. Секреты (пароли доп. БД)
-- хранятся только на сервере и НИКОГДА не возвращаются клиенту.
-- =====================================================================
BEGIN;

-- --- projects: бизнес-поля проекта ------------------------------------
-- status: жизненный цикл проекта (active/paused/draft/archived).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
-- database_ref: выбранная для проекта БД — 'primary-postgres' (основная) либо
-- id записи additional_databases. Текст, т.к. ссылается на разнородные сущности.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS database_ref text;
-- updated_at: метка изменения (optimistic concurrency через If-Match).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Ограничение допустимых статусов (добавляем, только если ещё нет).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_status_check'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_status_check
      CHECK (status IN ('active', 'paused', 'draft', 'archived'));
  END IF;
END $$;

COMMENT ON COLUMN projects.status IS 'Жизненный цикл: active/paused/draft/archived.';
COMMENT ON COLUMN projects.database_ref IS
  'Выбранная БД проекта: primary-postgres или id additional_databases.';

-- updated_at поддерживается общим триггером (функция из 0001_init).
DROP TRIGGER IF EXISTS projects_set_updated_at ON projects;
CREATE TRIGGER projects_set_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- --- additional_databases: дополнительные подключения к БД -------------
-- Глобальный справочник доп. подключений (не основная PostgreSQL).
-- secret (пароль) — только сервер; в ответах API не отдаётся (hasSecret).
CREATE TABLE IF NOT EXISTS additional_databases (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL DEFAULT '',
    host       text NOT NULL DEFAULT '',
    port       int  NOT NULL DEFAULT 5432,
    database   text NOT NULL DEFAULT '',
    db_user    text NOT NULL DEFAULT '',
    ssl_mode   text NOT NULL DEFAULT 'disable',
    -- Пароль/секрет подключения. СЕРВЕР-ОНЛИ, не возвращается клиенту.
    secret     text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE additional_databases IS
  'Дополнительные подключения к БД. secret хранится только на сервере.';
COMMENT ON COLUMN additional_databases.secret IS
  'Пароль подключения. СЕРВЕР-ОНЛИ: list/read никогда не возвращают это поле.';

DROP TRIGGER IF EXISTS additional_databases_set_updated_at ON additional_databases;
CREATE TRIGGER additional_databases_set_updated_at
    BEFORE UPDATE ON additional_databases
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- --- role_connectors: назначение «роль → коннектор (AI)» ---------------
-- Один коннектор на код роли. role_code — канонический код роли пайплайна.
-- connector_id ссылается на connectors (AI-интеграции, 0004). SET NULL при
-- удалении коннектора, чтобы не терять строку назначения.
CREATE TABLE IF NOT EXISTS role_connectors (
    role_code    text PRIMARY KEY,
    connector_id uuid REFERENCES connectors(id) ON DELETE SET NULL,
    updated_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE role_connectors IS
  'Назначение AI-коннектора роли пайплайна по каноническому коду роли.';

DROP TRIGGER IF EXISTS role_connectors_set_updated_at ON role_connectors;
CREATE TRIGGER role_connectors_set_updated_at
    BEFORE UPDATE ON role_connectors
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

COMMIT;

-- =====================================================================
-- DATABASE-CONNECTIONS-001 (ORCHESTRATOR-P1.4) — единая пользовательская модель
-- подключений к БД. Снимает деление «основная»/«дополнительная»: все доступные
-- проекту БД — это записи database_connections (бывш. additional_databases).
-- Внутреннее инфраструктурное подключение оркестратора (config/db.settings.json)
-- НЕ выдаётся за доступную проекту БД автоматически.
--
-- Идемпотентная миграция. ВНИМАНИЕ: переименовывает таблицу и меняет данные
-- projects.database_ref — применять ТОЛЬКО после отдельного подтверждения
-- пользователя (правила корневого TASKS.md и политики БД). До применения —
-- read-only аудит/preview (см. Programmer note задачи).
-- =====================================================================
BEGIN;

-- 1) Переименование additional_databases → database_connections (без дублирования).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = current_schema() AND table_name = 'additional_databases')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = current_schema() AND table_name = 'database_connections') THEN
    ALTER TABLE additional_databases RENAME TO database_connections;
  END IF;
END $$;

-- 2) Создать таблицу для свежих установок (если переименовывать было нечего).
CREATE TABLE IF NOT EXISTS database_connections (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL DEFAULT '',
    dbms_type  text NOT NULL DEFAULT 'postgres',
    host       text NOT NULL DEFAULT '',
    port       int  NOT NULL DEFAULT 5432,
    database   text NOT NULL DEFAULT '',
    db_user    text NOT NULL DEFAULT '',
    ssl_mode   text NOT NULL DEFAULT 'disable',
    -- Пароль/секрет. СЕРВЕР-ОНЛИ: list/read никогда не возвращают это поле.
    secret     text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3) Тип СУБД для переименованных строк.
ALTER TABLE database_connections ADD COLUMN IF NOT EXISTS dbms_type text NOT NULL DEFAULT 'postgres';

COMMENT ON TABLE database_connections IS
  'Единые пользовательские подключения к БД. Без категорий primary/additional. secret — server-only.';
COMMENT ON COLUMN database_connections.secret IS
  'Пароль подключения. СЕРВЕР-ОНЛИ: list/read никогда не возвращают это поле.';

-- 4) Триггер updated_at для (возможно переименованной) таблицы.
DROP TRIGGER IF EXISTS database_connections_set_updated_at ON database_connections;
CREATE TRIGGER database_connections_set_updated_at
    BEFORE UPDATE ON database_connections
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- 5) projects.database_ref: ссылки на бывшую системную 'primary-postgres' больше
-- не валидны (инфраструктурное подключение не является доступной БД). Переводим
-- такие проекты в состояние «без БД» (NULL). Ссылки на id database_connections
-- остаются как есть. Каскадного обнуления валидных ссылок НЕТ.
UPDATE projects SET database_ref = NULL WHERE database_ref = 'primary-postgres';

COMMIT;

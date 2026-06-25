-- =====================================================================
-- TOOLS-REGISTRY-001 — реестр инструментов (Tools), уровни доступа роли и MCP.
-- Идемпотентная миграция (повторный запуск безопасен).
-- =====================================================================
-- Модель:
--   * tools         — реестр инструментов. builtin (чтение/правка/запись/удаление
--                     проекта; исполняет микросервис tools-service) и mcp
--                     (MCP-сервер для Claude Code). У каждого builtin — уровень
--                     доступа (capability).
--   * role_capabilities — какие УРОВНИ разрешены роли (чекбоксы в карточке роли):
--                     read | modify | create | delete | execute. Роль получает все
--                     builtin-инструменты разрешённых уровней. Пример: аналитик —
--                     только read; программист — read+modify+create+delete.
--   * role_tools    — явная привязка MCP-серверов к роли (для Claude Code).
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS tools (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL UNIQUE,
    kind        text NOT NULL DEFAULT 'builtin' CHECK (kind IN ('builtin', 'mcp')),
    -- Уровень доступа builtin-инструмента (для mcp игнорируется).
    capability  text NOT NULL DEFAULT 'read'
                CHECK (capability IN ('read', 'modify', 'create', 'delete', 'execute')),
    description text NOT NULL DEFAULT '',
    config      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE tools IS 'Реестр инструментов: builtin (по уровням доступа) и mcp (для Claude Code).';

-- Разрешённые роли уровни доступа (чекбоксы карточки роли).
CREATE TABLE IF NOT EXISTS role_capabilities (
    role_code  text NOT NULL,
    capability text NOT NULL
               CHECK (capability IN ('read', 'modify', 'create', 'delete', 'execute')),
    PRIMARY KEY (role_code, capability)
);
COMMENT ON TABLE role_capabilities IS 'Уровни доступа роли: чем роль может пользоваться (read/modify/create/delete/execute).';

-- Явная привязка инструментов (прежде всего MCP-серверов) к роли.
CREATE TABLE IF NOT EXISTS role_tools (
    role_code text NOT NULL,
    tool_id   uuid NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    position  int  NOT NULL DEFAULT 0,
    PRIMARY KEY (role_code, tool_id)
);
COMMENT ON TABLE role_tools IS 'Назначение инструментов роли (прежде всего MCP-серверов).';
CREATE INDEX IF NOT EXISTS idx_role_tools_tool_id ON role_tools(tool_id);

DROP TRIGGER IF EXISTS tools_set_updated_at ON tools;
CREATE TRIGGER tools_set_updated_at
    BEFORE UPDATE ON tools
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- Сид встроенных инструментов по уровням доступа.
INSERT INTO tools (name, kind, capability, description) VALUES
    ('read_file',   'builtin', 'read',   'Прочитать файл проекта по относительному пути.'),
    ('list_dir',    'builtin', 'read',   'Список содержимого каталога проекта.'),
    ('search_text', 'builtin', 'read',   'Подстрочный поиск по тексту файлов проекта.'),
    ('edit_file',   'builtin', 'modify', 'Изменить файл: заменить фрагмент текста на новый.'),
    ('write_file',  'builtin', 'create', 'Создать или перезаписать файл проекта.'),
    ('delete_file', 'builtin', 'delete', 'Удалить файл проекта.')
ON CONFLICT (name) DO NOTHING;

-- Уровни по умолчанию: рассуждающие роли — только read; PROGRAMMER — полный набор
-- (read+modify+create+delete), т.к. реализует изменения. Идемпотентно.
INSERT INTO role_capabilities (role_code, capability)
SELECT rc.code, 'read'
  FROM (VALUES
    ('TASK_INTAKE_OFFICER'), ('ARCHITECT'), ('DECOMPOSER'), ('TASK_REVIEWER'),
    ('FAILURE_ANALYST'), ('DOCUMENTATION_AUDITOR'), ('DOCUMENTATION_KEEPER')
  ) AS rc(code)
ON CONFLICT (role_code, capability) DO NOTHING;

INSERT INTO role_capabilities (role_code, capability)
SELECT 'PROGRAMMER', cap
  FROM (VALUES ('read'), ('modify'), ('create'), ('delete')) AS c(cap)
ON CONFLICT (role_code, capability) DO NOTHING;

COMMIT;

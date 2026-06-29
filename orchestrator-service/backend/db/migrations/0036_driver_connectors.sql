-- =====================================================================
-- ROLE-ENGINE-ROUTING-001 — преднастроенные коннекторы-«драйверы».
--
-- Зачем: рассуждающие роли исполняются хостовыми движками Codex и Claude Code
-- (provider = 'codex' / 'claude_code'). Это драйверы, а не сетевые AI-API:
-- HTTP-endpoint и access_token у них пустые (см. connectors.js → isDriverProvider /
-- endpointForProvider). Чтобы их можно было сразу выбрать в карточке роли без
-- ручного создания коннектора, заводим обе записи прямо в миграции.
--
-- Read-only аудит перед миграцией:
--   таблица connectors уже существует (0004_connectors), колонки:
--     name (NOT NULL), provider (NOT NULL), endpoint (NOT NULL), is_enabled (bool),
--     access_token/model (DEFAULT '');
--   уникальность по lower(name) обеспечивает индекс connectors_name_unique.
-- Идемпотентно: ON CONFLICT (lower(name)) DO NOTHING — повторный накат не дублирует.
-- =====================================================================
BEGIN;

INSERT INTO connectors (name, provider, endpoint, is_enabled)
VALUES
    ('Codex',       'codex',       '', true),
    ('Claude Code', 'claude_code', '', true)
ON CONFLICT (lower(name)) DO NOTHING;

COMMIT;

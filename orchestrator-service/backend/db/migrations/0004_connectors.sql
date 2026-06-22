-- =====================================================================
-- Коннекторы внешних AI-провайдеров (DeepSeek и OpenAI-совместимые) +
-- структурированный журнал обмена промтами.
-- Портирован из Connector_Service (Go): connection.connector / ai.prompt_exchange.
-- Идемпотентная миграция.
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- Коннектор (подключение к ИИ). Аналог connection.connector.
-- access_token — секрет, наружу по сети не отдаётся (см. redact в API).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connectors (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name             text NOT NULL,
    provider         text NOT NULL DEFAULT 'deepseek',
    endpoint         text NOT NULL,
    access_token     text NOT NULL DEFAULT '',
    model            text NOT NULL DEFAULT '',
    consumer_service text NOT NULL DEFAULT '',
    priority         integer NOT NULL DEFAULT 100,
    is_enabled       boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE connectors IS
  'Подключения к внешним AI-провайдерам (DeepSeek / OpenAI-совместимые).';
COMMENT ON COLUMN connectors.access_token IS
  'Секрет (Bearer). Никогда не возвращается клиенту — только флаг has_token.';

CREATE UNIQUE INDEX IF NOT EXISTS connectors_name_unique
    ON connectors (lower(name));

-- ---------------------------------------------------------------------
-- Журнал обмена промтами. Аналог ai.prompt_exchange.
-- Статусы (как в источнике): Создан / отправлен / завершен / ошибка.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prompt_exchanges (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id     uuid REFERENCES connectors(id) ON DELETE CASCADE,
    consumer_service text NOT NULL DEFAULT '',
    prompt           text,
    response         text,
    status           text NOT NULL DEFAULT 'Создан',
    is_manual        boolean NOT NULL DEFAULT false,
    error            text,
    http_status      integer,
    duration_ms      integer,
    created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE prompt_exchanges IS
  'Структурированный журнал обмена через коннектор: промт, ответ, статус, тайминг.';

CREATE INDEX IF NOT EXISTS idx_prompt_exchanges_connector
    ON prompt_exchanges (connector_id, created_at DESC);

COMMIT;

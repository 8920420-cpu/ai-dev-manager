-- =====================================================================
-- INTAKE-INTEGRATIONS-001 — третий канал приёма роли Task Intake Officer:
-- «интеграции в приложения». Конечные пользователи продуктов сообщают о
-- проблемах изнутри программ; обращения поступают роли Приёмщика (BACKLOG),
-- который сам определяет проект по картам зарегистрированных проектов.
--
-- Что вводит миграция:
--   1) Реестр интеграций-источников обращений (intake_integrations): название,
--      хэш токена доступа (секрет наружу не отдаётся — только SHA-256), признак
--      включена/выключена, rate-limit по интеграции и по пользователю, минимальная
--      длина сообщения (анти-спам). БЕЗ обязательной привязки к проекту.
--   2) tasks.intake_integration_id — источник обращения (для статистики и
--      идемпотентности). Частичный уникальный индекс (intake_integration_id,
--      external_id) — повторная доставка того же обращения не создаёт дубль.
--   3) intake_report_seq — человекочитаемый номер обращения («Заявка №X принята»).
--   4) Дополнение промта роли: как разрешать проект беспроектного обращения по
--      каталогу проектов и подсказкам (микросервис-источник и форма).
--
-- Не смешивать с «Движком» роли и с коннекторами (таблица connectors): движок —
-- чем роль думает; интеграции обращений — откуда приходят обращения.
--
-- Идемпотентная миграция (повторный запуск безопасен).
-- =====================================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- --- Реестр интеграций-источников обращений ---------------------------------
CREATE TABLE IF NOT EXISTS intake_integrations (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                     text NOT NULL,
    -- SHA-256 hex токена доступа. Сам токен клиенту не хранится и по сети не
    -- отдаётся (наружу — только флаг has_token). Пусто = токен ещё не выпущен.
    token_hash               text NOT NULL DEFAULT '',
    enabled                  boolean NOT NULL DEFAULT true,
    -- Анти-спам: лимиты приёма (обращений в минуту) и минимальная длина сообщения.
    rate_limit_per_min       integer NOT NULL DEFAULT 60,
    user_rate_limit_per_min  integer NOT NULL DEFAULT 20,
    min_message_length       integer NOT NULL DEFAULT 10,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE intake_integrations IS
  'Зарегистрированные внешние приложения-источники обращений о проблемах (третий канал приёма Task Intake Officer).';
COMMENT ON COLUMN intake_integrations.token_hash IS
  'SHA-256 hex токена доступа. Секрет наружу не отдаётся — только флаг has_token.';

CREATE UNIQUE INDEX IF NOT EXISTS intake_integrations_name_unique
    ON intake_integrations (lower(name));
-- Токен уникален среди выпущенных (пустой хэш дублей не образует).
CREATE UNIQUE INDEX IF NOT EXISTS intake_integrations_token_hash_unique
    ON intake_integrations (token_hash) WHERE token_hash <> '';

-- --- Привязка задачи к источнику обращения ----------------------------------
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS intake_integration_id uuid
    REFERENCES intake_integrations(id) ON DELETE SET NULL;

COMMENT ON COLUMN tasks.intake_integration_id IS
  'Интеграция-источник обращения (канал «интеграции в приложения»). NULL — задача пришла из другого канала.';

-- Идемпотентность приёма: (intake_integration_id, external_id) уникальна.
-- Обычный UNIQUE не ловит дубли при NULL (в SQL NULL != NULL), поэтому частичный
-- индекс только среди обращений из интеграций с непустым external_id.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tasks_integration_external
    ON tasks (intake_integration_id, external_id)
    WHERE intake_integration_id IS NOT NULL AND external_id IS NOT NULL;

-- Существующий индекс uniq_tasks_unassigned_external (миграция 0028) уникален по
-- external_id для ВСЕХ беспроектных задач (project_id IS NULL). Обращения из
-- интеграций тоже беспроектные, поэтому этот индекс ложно склеивал бы обращения
-- РАЗНЫХ интеграций с одинаковым external_id (каждый источник нумерует свои
-- обращения независимо, с 1), а также обращение и неразобранную scanner-задачу —
-- при этом findDup по (intake_integration_id, external_id) дубль бы не нашёл, и
-- приём падал бы с 23505. Сужаем старый индекс до scanner-задач без интеграции;
-- идемпотентность обращений обеспечивает uniq_tasks_integration_external выше.
DROP INDEX IF EXISTS uniq_tasks_unassigned_external;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tasks_unassigned_external
    ON tasks (external_id)
    WHERE project_id IS NULL AND external_id IS NOT NULL AND intake_integration_id IS NULL;

-- Человекочитаемый номер обращения («Заявка №X принята»). Отдельная
-- последовательность, независимая от UUID задачи.
CREATE SEQUENCE IF NOT EXISTS intake_report_seq;

-- --- Дополнение промта роли о канале интеграций ------------------------------
-- Guard-marker: дописываем один раз (повторный запуск миграции не дублирует).
UPDATE roles SET prompt = prompt || $intake$

<!-- INTAKE-INTEGRATIONS-001 -->

## Channel: application integrations (problem reports)
Some tasks arrive from the "application integrations" channel: an end user reported a problem from inside a product. Such a report has no project assigned yet (`project` is unknown) and its context includes `projectCatalog` — the list of all registered projects with their services.

When the task has no project, resolve the project yourself:
- Use `projectCatalog` and the hints from the report (source microservice and the form/screen the message was written from) to pick the matching registered project.
- Put the resolved project code into the `project` field. Also fill `service`, `component`, `short_title`, and `structured_description` as usual.
- Only set `project` to `unknown` (and return `BLOCKED` with a blocking question) if no registered project plausibly matches — do not guess.

A report resolved to a project is routed straight to the Architect; it must not linger in the unassigned inbox.
$intake$
 WHERE code = 'TASK_INTAKE_OFFICER'
   AND prompt IS NOT NULL
   AND prompt NOT LIKE '%INTAKE-INTEGRATIONS-001%';

COMMIT;

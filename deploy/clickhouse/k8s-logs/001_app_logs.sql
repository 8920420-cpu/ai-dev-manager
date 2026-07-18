-- LOGGING-STANDARD-001 — структурный слой логов k8s поверх сырого потока Fluent Bit.
--
-- КОНТЕКСТ. Fluent Bit (deploy/k8s/60-k8s-logs-clickhouse.yaml) складывает СЫРЫЕ строки
-- контейнеров в k8s.container_logs (по одной строке приложения в колонку `log`).
-- Эта миграция НЕ ломает сырой поток (только ADD COLUMN), а добавляет структурный
-- разбор: MATERIALIZED VIEW парсит JSON-логи (формат LOGGING-STANDARD-001) из `log`
-- в колоночную k8s.app_logs. Не-JSON строки (nginx, Go, kube-system) остаются только
-- в сыром container_logs — это осознанный компромисс для смешанного парка сервисов.
--
-- Все выражения идемпотентны (IF NOT EXISTS / CREATE OR REPLACE) — можно гонять повторно.
-- Применение на живой CH: см. deploy/clickhouse/k8s-logs/README (или apply-скрипт).

CREATE DATABASE IF NOT EXISTS k8s;

-- 1) Сырая таблица уже существует (создана вручную). Добавляем только `node`
--    (имя ноды из kubernetes-фильтра) — не выводится из пути файла. Аддитивно.
ALTER TABLE k8s.container_logs ADD COLUMN IF NOT EXISTS node LowCardinality(String) DEFAULT '';
-- k8s_labels: JSON меток пода (kubernetes-фильтр Fluent Bit → Lua-энкодер). Аддитивно.
ALTER TABLE k8s.container_logs ADD COLUMN IF NOT EXISTS k8s_labels String DEFAULT '';

-- 2) Структурная таблица приложений. Колонки — обязательные и частые поля стандарта;
--    длинный хвост полей — в attributes Map. raw хранит исходную строку (ZSTD).
CREATE TABLE IF NOT EXISTS k8s.app_logs
(
    ts              DateTime64(3, 'UTC'),
    level           LowCardinality(String) DEFAULT 'info',
    service         LowCardinality(String) DEFAULT '',
    service_version LowCardinality(String) DEFAULT '',
    env             LowCardinality(String) DEFAULT '',
    -- Kubernetes-метаданные (из коллектора / пути файла).
    namespace       LowCardinality(String) DEFAULT '',
    pod             String DEFAULT '',
    container       LowCardinality(String) DEFAULT '',
    node            LowCardinality(String) DEFAULT '',
    labels          Map(String, String),
    -- Событие.
    message         String,
    event_code      LowCardinality(String) DEFAULT '',
    event_category  LowCardinality(String) DEFAULT '',
    operation       String DEFAULT '',
    operation_type  LowCardinality(String) DEFAULT '',
    protocol        LowCardinality(String) DEFAULT '',
    method          LowCardinality(String) DEFAULT '',
    route           String DEFAULT '',
    -- Корреляция.
    request_id      String DEFAULT '',
    correlation_id  String DEFAULT '',
    trace_id        String DEFAULT '',
    span_id         String DEFAULT '',
    parent_span_id  String DEFAULT '',
    -- Результат/производительность.
    status          LowCardinality(String) DEFAULT '',
    status_code     UInt16 DEFAULT 0,
    duration_ms     Float64 DEFAULT 0,
    retry_count     UInt16 DEFAULT 0,
    -- Бизнес-контекст (заполняется только бизнес-событиями).
    tenant_id       String DEFAULT '',
    user_id         String DEFAULT '',
    entity_type     LowCardinality(String) DEFAULT '',
    entity_id       String DEFAULT '',
    -- Ошибка.
    error_code      LowCardinality(String) DEFAULT '',
    error_type      LowCardinality(String) DEFAULT '',
    error_message   String DEFAULT '',
    retryable       UInt8 DEFAULT 0,
    action_required LowCardinality(String) DEFAULT '',
    operator_hint   String DEFAULT '',
    stack_trace     String DEFAULT '' CODEC(ZSTD(3)),
    -- Длинный хвост + исходник.
    attributes      Map(String, String),
    raw             String CODEC(ZSTD(3)),
    INDEX idx_trace     trace_id     TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_request   request_id   TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_event     event_code   TYPE set(256)           GRANULARITY 4,
    INDEX idx_error     error_code   TYPE set(256)           GRANULARITY 4,
    INDEX idx_entity    entity_id    TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (service, level, ts)
TTL toDateTime(ts) + INTERVAL 90 DAY DELETE WHERE level IN ('error', 'fatal'),
    toDateTime(ts) + INTERVAL 30 DAY DELETE WHERE level NOT IN ('error', 'fatal')
SETTINGS index_granularity = 8192;

-- Миграция существующей app_logs (созданной до колонки labels). Аддитивно.
ALTER TABLE k8s.app_logs ADD COLUMN IF NOT EXISTS labels Map(String, String) AFTER node;

-- 3) MATERIALIZED VIEW: парсит JSON-строки из сырого потока в структурную таблицу.
--    ВНИМАНИЕ: изменение SELECT существующего MV требует DROP TABLE k8s.app_logs_mv
--    + повторный CREATE (SELECT у MV нельзя ALTER-ить). Данные app_logs при этом не
--    теряются. На свежем volume срабатывает CREATE ... IF NOT EXISTS ниже.
--    Условие log LIKE '{%' отсекает не-JSON (текстовые) логи. namespace/pod/container
--    восстанавливаются из пути файла тем же регэкспом, что и materialized-колонки
--    сырой таблицы; node берётся из добавленной колонки. ts — из поля лога, иначе
--    время приёма контейнером.
CREATE MATERIALIZED VIEW IF NOT EXISTS k8s.app_logs_mv TO k8s.app_logs AS
SELECT
    ifNull(parseDateTime64BestEffortOrNull(JSONExtractString(log, 'ts'), 3, 'UTC'), ts) AS ts,
    lower(JSONExtractString(log, 'level'))                                              AS level,
    coalesce(nullIf(JSONExtractString(log, 'service'), ''), container)                  AS service,
    JSONExtractString(log, 'service_version')                                          AS service_version,
    JSONExtractString(log, 'env')                                                      AS env,
    extract(file, '/[^/_]+_([^/_]+)_[^/]+-[0-9a-f]+\\.log$')                            AS namespace,
    extract(file, '/([^/_]+)_[^/_]+_[^/]+-[0-9a-f]+\\.log$')                            AS pod,
    extract(file, '/[^/_]+_[^/_]+_([^/]+)-[0-9a-f]+\\.log$')                            AS container,
    node                                                                               AS node,
    CAST(JSONExtractKeysAndValues(k8s_labels, 'String') AS Map(String, String))        AS labels,
    JSONExtractString(log, 'message')                                                  AS message,
    JSONExtractString(log, 'event_code')                                               AS event_code,
    JSONExtractString(log, 'event_category')                                           AS event_category,
    JSONExtractString(log, 'operation')                                                AS operation,
    JSONExtractString(log, 'operation_type')                                           AS operation_type,
    JSONExtractString(log, 'protocol')                                                 AS protocol,
    JSONExtractString(log, 'method')                                                   AS method,
    JSONExtractString(log, 'route')                                                    AS route,
    JSONExtractString(log, 'request_id')                                               AS request_id,
    JSONExtractString(log, 'correlation_id')                                           AS correlation_id,
    JSONExtractString(log, 'trace_id')                                                 AS trace_id,
    JSONExtractString(log, 'span_id')                                                  AS span_id,
    JSONExtractString(log, 'parent_span_id')                                           AS parent_span_id,
    JSONExtractString(log, 'status')                                                   AS status,
    toUInt16OrZero(JSONExtractString(log, 'status_code'))                              AS status_code,
    JSONExtractFloat(log, 'duration_ms')                                               AS duration_ms,
    toUInt16OrZero(JSONExtractString(log, 'retry_count'))                              AS retry_count,
    JSONExtractString(log, 'tenant_id')                                                AS tenant_id,
    JSONExtractString(log, 'user_id')                                                  AS user_id,
    JSONExtractString(log, 'entity_type')                                              AS entity_type,
    JSONExtractString(log, 'entity_id')                                                AS entity_id,
    JSONExtractString(log, 'error_code')                                               AS error_code,
    JSONExtractString(log, 'error_type')                                               AS error_type,
    JSONExtractString(log, 'error_message')                                            AS error_message,
    JSONExtractBool(log, 'retryable')                                                  AS retryable,
    JSONExtractString(log, 'action_required')                                          AS action_required,
    JSONExtractString(log, 'operator_hint')                                            AS operator_hint,
    JSONExtractString(log, 'stack_trace')                                              AS stack_trace,
    CAST(JSONExtractKeysAndValues(log, 'attributes', 'String') AS Map(String, String)) AS attributes,
    log                                                                                AS raw
FROM k8s.container_logs
WHERE log LIKE '{%' AND JSONHas(log, 'level');

-- 4) Аналитические view (severity считаем из level: error/fatal — реальные сбои).

-- Доля ошибок и латентность по сервису за час.
CREATE OR REPLACE VIEW k8s.app_health_by_hour AS
SELECT
    toStartOfHour(ts) AS hour,
    service,
    count()                                              AS events,
    countIf(level = 'warn')                              AS warnings,
    countIf(level IN ('error', 'fatal'))                 AS errors,
    round(countIf(level IN ('error', 'fatal')) / count(), 4) AS error_ratio,
    round(quantileIf(0.95)(duration_ms, duration_ms > 0)) AS p95_ms
FROM k8s.app_logs
GROUP BY hour, service;

-- Топ кодов ошибок за день.
CREATE OR REPLACE VIEW k8s.app_top_error_codes AS
SELECT
    toDate(ts) AS day,
    service,
    error_code,
    error_type,
    any(operator_hint) AS operator_hint,
    count()            AS failures
FROM k8s.app_logs
WHERE level IN ('error', 'fatal') AND error_code != ''
GROUP BY day, service, error_code, error_type;

-- Латентность HTTP по маршруту (p50/p95/p99).
CREATE OR REPLACE VIEW k8s.app_http_latency AS
SELECT
    toStartOfHour(ts) AS hour,
    service,
    route,
    count()                                 AS requests,
    round(quantile(0.50)(duration_ms))      AS p50_ms,
    round(quantile(0.95)(duration_ms))      AS p95_ms,
    round(quantile(0.99)(duration_ms))      AS p99_ms,
    countIf(status_code >= 500)             AS errors_5xx
FROM k8s.app_logs
WHERE event_category = 'http.request' AND duration_ms > 0
GROUP BY hour, service, route;

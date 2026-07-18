# Стандарт логирования k8s → ClickHouse (LOGGING-STANDARD-001)

> Статус: v1 (зафиксирован 2026-07-14). Ратифицированная схема — **до** массовой правки
> логов остальных сервисов сверяться с ней.
> Реализация ядра: `shared/logging/`, `deploy/clickhouse/k8s-logs/`, `deploy/k8s/60-k8s-logs-clickhouse.yaml`.

Итоговая цель: по **одной** записи в ClickHouse оператор, разработчик или ИИ-агент
определяет сервис, операцию, бизнес-сущность, пользователя/организацию, цепочку
связанных вызовов, первопричину, возможность повтора и рекомендуемое действие.

---

## 1. Текущее состояние (до изменений)

Два независимых потока в ClickHouse:

| Поток | Путь | Таблица | Статус |
|---|---|---|---|
| A. События прогонов ролей | приложение-оркестратор пушит напрямую | `orchestrator.orchestrator_observability_events` | зрелый (error_component/severity, view, тесты) |
| B. Логи контейнеров k8s | `stdout` пода → Fluent Bit → HTTP INSERT | `k8s.container_logs` | **был сырым — предмет этой работы** |

Поток B до изменений: сервисы писали `console.error('[svc] текст', {obj})` (не JSON) →
Fluent Bit `tail`+`cri` клал всю строку в одну колонку `log` без k8s-метаданных
(кроме namespace/pod/container из пути), без multiline, без маскирования, без
фильтрации шума. Таблица `k8s.container_logs` не была зафиксирована в git.

**Критические риски (были):** невозможны фильтр по уровню/коду, трассировка между
сервисами, поиск по trace_id; рваные стектрейсы; риск утечки секретов; недокументированная
прод-схема.

## 2. Целевая архитектура

```
Node-сервис → shared/logging (JSON, 1 строка = 1 событие)
  stdout ▼
Fluent Bit: tail(multiline.parser cri) → node из Downward API → drop(probes/logging-ns)
            → Lua-redaction(секреты)
  HTTP INSERT ▼
k8s.container_logs (raw, TTL 30д)  ──MV(парсит JSON)──►  k8s.app_logs (структурная)
                                                          error/fatal TTL 90д, прочее 30д
```

Границы (не смешивать): **лог** — диагностика/поиск; **аудит** действий пользователей —
отдельная таблица `audit_logs` (при появлении требований); **доменные события** —
поток A / отдельная таблица; **метрики** — Prometheus; **трассировки** — OpenTelemetry,
в логе только `trace_id`/`span_id` как мост.

Принцип: коллектор простой и устойчивый (переживает смесь JSON/не-JSON логов),
JSON→колонки разбирает ClickHouse через MATERIALIZED VIEW — схему меняем без
передеплоя DaemonSet.

## 3. Стандарт полей события

Формат — JSON, одна строка. Группы обязательности:

| Поле | Тип | Обязательность | Источник | Описание |
|---|---|---|---|---|
| `ts` | ISO-8601 UTC | всегда | логгер | Время события |
| `level` | enum | всегда | логгер | trace/debug/info/warn/error/fatal |
| `message` | string ≤16k | всегда | вызов | Человекочитаемо; НЕ единственная классификация |
| `service` | string | всегда | логгер | orchestrator-service/tools-service/mcp-service |
| `service_version` | string | желательно | env `APP_CODE_VERSION` | git-SHA сборки |
| `env` | string | всегда | env | production/staging/… |
| `namespace`/`pod`/`container`/`node` | string | всегда | коллектор | k8s-метаданные |
| `labels` | map | опционально | коллектор (kubernetes-фильтр) | Метки пода (app/version/…) |
| `event_code` | UPPER_SNAKE | для значимых событий | вызов (реестр) | Стабильный код, не из текста |
| `event_category` | string | для значимых | вызов | http.request/database.query/… |
| `operation` | string | HTTP/gRPC/job/db/внешние | вызов | `GET /api/x`, `order.create` |
| `operation_type` | enum | как выше | вызов | inbound/outbound/internal/background |
| `protocol`/`method`/`route` | string | HTTP | middleware | |
| `grpc_service`/`grpc_method` | string | gRPC | middleware | |
| `request_id` | string | запрос | middleware | Идентификатор запроса |
| `correlation_id` | string | запрос | middleware | Сквозной id бизнес-операции |
| `trace_id` | 32 hex | запрос | middleware/W3C | Мост к OpenTelemetry |
| `span_id`/`parent_span_id` | 16 hex | запрос | middleware | |
| `status` | enum | операции | вызов | started/success/failed/skipped/timeout/cancelled |
| `status_code` | uint16 | HTTP | middleware | |
| `duration_ms` | number | операции | middleware | |
| `retry_count` | uint | ретраи | вызов | |
| `tenant_id`/`user_id`/`session_id` | string | бизнес/аудит | контекст | Заполняется, где применимо |
| `entity_type`/`entity_id`/`document_id` | string | бизнес-события | вызов | Для восстановления истории сущности |
| `error_code` | UPPER_SNAKE | ошибки | вызов (реестр) | Стабильный код ошибки |
| `error_type` | enum | ошибки | реестр | validation/authentication/…/internal |
| `error_message`/`error_source` | string | ошибки | вызов/Error | |
| `stack_trace` | string | ошибки | Error | Контролируемо, ZSTD |
| `retryable` | bool | ошибки | реестр | Можно ли повторить |
| `action_required`/`operator_hint` | string | ошибки, требующие реакции | реестр | Что делать оператору |
| `dependency_*` | string/number | внешние вызовы | вызов | name/type/operation/status/duration |
| `attributes` | map | опционально | вызов | Длинный хвост (НЕ новые колонки) |

Обязательные подмножества: **все** (`ts,level,message,service,env` + k8s-мета); **HTTP**
(`event_code,operation,method,route,status,status_code,duration_ms,request_id,trace_id`);
**gRPC** (`grpc_service,grpc_method,status,duration_ms,trace_id`); **фоновые** (`operation,
operation_type=background,status,duration_ms`); **БД** (`event_category=database.query,
operation,duration_ms`); **внешние** (`dependency_*,status,duration_ms`); **бизнес**
(`event_code,entity_type,entity_id` + идентификаторы субъекта); **ошибки** (`error_code,
error_type,error_message,stack_trace,retryable`).

JSON-Schema: `shared/logging/event.schema.json`.

## 4. Классификация событий

Технические категории: `application.lifecycle`, `http.request`, `grpc.request`,
`database.query`, `cache.operation`, `message.publish`, `message.consume`,
`external_api.request`, `authentication`, `authorization`, `background_job`,
`infrastructure`, `validation`, `exception`.

Бизнес-категории (пример для домена): `order.*`, `document.*`, `stock.*`,
`shipment.*`, `payment.registered`, `price.calculated`, `integration.sync_*`.
Бизнес-событие должно позволять восстановить историю сущности по `entity_id` без
чтения исходников (запрос №14).

## 5. Каталог событий (стартовый, `shared/logging/registry.js`)

| event_code | category | level | описание |
|---|---|---|---|
| APP_STARTED | application.lifecycle | info | Сервис слушает порт |
| APP_STOPPING | application.lifecycle | info | Плановая остановка |
| APP_BOOT_STEP | application.lifecycle | info | Шаг инициализации |
| APP_BOOT_FAILED | application.lifecycle | error | Ошибка инициализации |
| HTTP_REQUEST_COMPLETED | http.request | info | Запрос обработан (2xx/3xx) |
| HTTP_REQUEST_REJECTED | http.request | warn | Отклонён (4xx) |
| HTTP_REQUEST_FAILED | http.request | error | Необработанная ошибка (5xx) |
| EXTERNAL_API_REQUEST/FAILED | external_api.request | debug/error | Исходящий вызов |
| DB_QUERY_FAILED | database.query | error | Ошибка запроса к БД |
| AUTH_LOGIN_SUCCESS / AUTH_INVALID_CREDENTIALS | authentication | info/warn | |
| AUTHZ_DENIED | authorization | warn | Нет прав |
| JOB_STARTED/COMPLETED/FAILED | background_job | info/info/error | Фоновая задача |
| OBSERVABILITY_EXPORT_SKIPPED | infrastructure | warn | Экспорт best-effort пропущен |

Правило именования: `event_code` = UPPER_SNAKE, стабилен, не выводится из `message`.
Новые коды добавлять в реестр (реестр не даёт дублировать смысл разными кодами).

## 6. Каталог ошибок (стартовый)

| error_code | type | retryable | action_required | operator_hint |
|---|---|---|---|---|
| VALIDATION_FAILED | validation | нет | fix_input | Проверьте корректность входных данных |
| UNAUTHORIZED | authentication | нет | check_token | Проверьте ORCHESTRATOR_API_TOKEN |
| FORBIDDEN | authorization | нет | check_permissions | Не хватает прав на операцию |
| NOT_FOUND | not_found | нет | — | — |
| PAYLOAD_TOO_LARGE | validation | нет | reduce_payload | Тело превышает лимит |
| DB_QUERY_TIMEOUT | timeout | да | check_db | Проверьте нагрузку Postgres |
| DB_UNAVAILABLE | dependency | да | check_db | БД недоступна (CNPG/Patroni) |
| EXTERNAL_API_UNAVAILABLE | dependency | да | check_dependency | Зависимость недоступна |
| EXTERNAL_API_TIMEOUT | timeout | да | check_dependency | Таймаут исходящего вызова |
| RATE_LIMITED | rate_limit | да | backoff | Лимит вызовов — backoff |
| INTERNAL_ERROR | internal | нет | investigate | Смотрите stack_trace и trace_id |

`operator_hint`/`action_required` — только для ошибок и ситуаций, требующих реакции.

## 7. Уровни логирования

- **TRACE** — глубокая диагностика, не включать в production постоянно.
- **DEBUG** — детали для разработчика; без секретов и огромных payload.
- **INFO** — успешное завершение значимой операции, смена состояния, старт/стоп.
- **WARN** — восстановимая аномалия, деградация, retry, fallback, ожидаемая ошибка
  валидации/авторизации (4xx).
- **ERROR** — операция не завершилась, затронут пользователь/бизнес-процесс (5xx).
- **FATAL** — процесс не может продолжать работу.

Правила: обычные успешные запросы — INFO, не ERROR; ожидаемые 4xx — WARN, не ERROR;
одна ошибка логируется **окончательно на одном слое** (для HTTP — в общем catch
обработчика, с `err`+stack; промежуточные слои не дублируют). Гейт — `LOG_LEVEL`
(деф. `info`), меняется по окружению.

## 8. Корреляция (реализовано)

`shared/logging/http.js` + `context.js` (AsyncLocalStorage):
- вход: `traceparent` (W3C) → `trace_id`/`parent_span_id`; иначе `x-trace-id`/`x-request-id`;
  новый id создаётся **только** при отсутствии/невалидности входящего;
- контекст (`request_id,correlation_id,trace_id,span_id,tenant_id,user_id`) наследуется
  во все события запроса автоматически;
- ответ: `x-request-id` + `traceresponse`;
- исходящие: `propagationHeaders(ctx)` даёт `traceparent`/`x-request-id` для проброса
  в зависимости (HTTP/MCP/очереди/фоновые задания).
- `trace_id` — 32 hex (совместим с OpenTelemetry): по записи в ClickHouse можно перейти
  в распределённую трассировку или собрать все события операции (запросы №2,3).

## 9. Секреты и чувствительные данные (реализовано)

Два рубежа:
1. **Приложение** — `shared/logging/redact.js`: маскирование по имени поля (пароли,
   токены, `authorization`, `cookie`, `secret`, `connection_string`, приватные ключи,
   PII), allowlist заголовков, ограничение длины строк/массивов/глубины, маскирование
   Bearer/паролей/DSN в свободном тексте.
2. **Коллектор** — Lua в Fluent Bit маскирует те же паттерны в сырой строке (предохранитель).

Запрещено логировать по умолчанию: полные тела запросов/ответов, содержимое закрытых
документов, банковские реквизиты, приватные ключи, строки подключения.

## 10. Снижение шума (реализовано частично)

- `/health`, `/healthz`, `/readiness` и k8s-probes не логируются (middleware + Lua `kube-probe`);
- собственный namespace `logging` исключён (без цикла);
- TTL: error/fatal 90д, прочее 30д (raw — 30д);
- multiline склеивает стектрейсы в одно событие.

Дальше (по мере надобности): sampling частых одинаковых событий, rate-limit, агрегация
подавленных с сохранением счётчика, `async_insert` для throughput (включён на выходе CH).

## 11. Схема ClickHouse (применена и верифицирована)

`deploy/clickhouse/k8s-logs/001_app_logs.sql` (идемпотентно, аддитивно — сырой поток не ломается):
- `ALTER TABLE k8s.container_logs ADD COLUMN node` (из Downward API);
- `k8s.app_logs` — колоночная: level/service/*k8s-мета*/event_code/корреляция/status/
  duration_ms/error_*/attributes Map/raw; ORDER BY `(service, level, ts)`; PARTITION по
  месяцам; skip-индексы (bloom trace_id/request_id/entity_id; set event_code/error_code);
  дифференцированный TTL;
- `k8s.app_logs_mv` — MATERIALIZED VIEW: парсит JSON из `container_logs.log` (условие
  `log LIKE '{%'`), не-JSON остаётся в сыром потоке;
- view: `app_health_by_hour`, `app_top_error_codes`, `app_http_latency`.

Совместимость: исторические сырые данные не трогаются; MV работает вперёд; при желании
backfill — `INSERT INTO k8s.app_logs SELECT … FROM k8s.container_logs WHERE …`.

## 12. Запросы

25 готовых сценариев — `deploy/clickhouse/k8s-logs/queries.sql` (ошибки сервиса, trace,
цепочка, топ error_code, новые ошибки, после деплоя, медленные HTTP/gRPC/DB, внешние
интеграции, retry, по tenant/сущности, история документа, по pod/node, сравнение версий,
рост WARN/ERROR, незавершённые операции, зависшие job, повторная обработка очереди,
требующие оператора, retryable, без trace_id, нарушения стандарта, шумные коды).

## 13. Дашборды и алерты (рекомендация)

Панели: **Здоровье** (RPS, доля ошибок, latency p50/p95/p99, рестарты, ошибки по версии
из `app_health_by_hour`); **Ошибки** (топ/новые error_code, по сервису/tenant/деплою,
внешние зависимости, `action_required`); **Производительность** (p50/p95/p99, медленные
операции/зависимости/БД из `app_http_latency`); **Бизнес** (успех/неуспех операций,
незавершённые процессы, отказы интеграций, повторные обработки).

Алерты (с защитой от шума — не на единичную ожидаемую ошибку): доля ошибок > базовой,
появление нового `error_code`, отсутствие success-событий у сервиса, рост latency,
массовые retry, всплеск ошибок после деплоя (смена `service_version`), недоступность
внешней зависимости, отсутствие логов от сервиса N минут.

## 14. Стандарт проверки (реализовано)

- `shared/logging/registry.validateRecord()` — нарушения (нет event_code при ошибке,
  нет service, неверный level/status, невалидный ts, слишком длинный message,
  duration_ms не число, незарегистрированный код при `strictRegistry`);
- тесты `orchestrator-service/backend/test/logging.test.js` (node --test);
- SQL №24 находит нарушителей стандарта уже в ClickHouse.

## 15. План миграции остальных сервисов

1. (сделано) Зафиксировать схему + собрать `shared/logging` + применить ClickHouse.
2. (сделано) Перевести 3 k8s-сервиса: correlation-middleware, access-лог, boot-логи,
   финальный catch с `err`.
3. Переводить внутренние `console.*` точечно на `log.*` с `event_code` (не ломая бизнес-логику).
4. PS-стек/nginx/Go-сервисы (вне этого репо) — принять тот же стандарт полей, библиотеки
   естественные для языка; до перевода их текстовые логи остаются в сыром `container_logs`.
5. Дашборды/алерты в Grafana поверх `k8s.app_logs`.

## 16. Что вне репозитория / не проверено

- Деплой Fluent Bit (`kubectl apply -f deploy/k8s/60-k8s-logs-clickhouse.yaml`) и rollout
  образов — нужен kubeconfig прод-кластера (в этой сессии недоступен: `~/.kube/config`
  указывает на localhost). Команды — в разделе «Деплой» README.
- Логи PS-стека/nginx/Go — отдельные репозитории; здесь только приняли стандарт.
- Labels подов в `app_logs.labels` (Map) — реализовано: kubernetes-фильтр Fluent Bit +
  RBAC (SA `fluent-bit` + ClusterRole на чтение pods/namespaces) + Lua-энкодер меток в
  `k8s_labels` → MV. Аннотации не собираем (шум); `node` берём дёшево из Downward API.
  CH-часть (колонки `k8s_labels`/`labels` + пересозданный MV) применена и верифицирована;
  Fluent Bit-часть ждёт `kubectl apply` (нужен kubeconfig кластера).

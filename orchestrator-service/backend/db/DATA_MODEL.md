# DATA_MODEL.md — AI Orchestrator

Единый источник истины оркестрации ИИ-агентов: задачи, статусы, роли,
агенты, промты, запуски, блокировки сервисов, пайплайны, ревью, деплои,
артефакты, документы и **полная история изменений**.

- **СУБД:** PostgreSQL 16 (контейнер `infra-postgres-1`)
- **База:** `orchestrator_db`
- **Подключение:** `postgresql://postgres:postgres@127.0.0.1:5432/orchestrator_db`
- **Миграция:** [db/migrations/0001_init.sql](migrations/0001_init.sql)
- **Seed:** [db/seed/0001_seed.sql](seed/0001_seed.sql)

Все первичные ключи — `uuid` (`gen_random_uuid()`). Все временные метки —
`timestamptz` (`now()`). Статусы — через ENUM-типы.

---

## 1. Пайплайн оркестратора

```text
Backlog → Architect → Decomposer → Programmer → Scanner → Task Reviewer
        → Pipeline Service → Failure Analyst (только при падении, затем Programmer)
        → Documentation Auditor → Documentation Keeper (если нужен)
        → Git Integrator → Done
```

Каждая роль работает независимо; все переходы фиксируются в `task_events`.

---

## 2. ER-модель (текстовая)

```text
projects ─┬─< services ─┬─< service_dependencies (source/target)
          │             ├─< service_locks >── agents
          │             └─< tasks.service_id
          ├─< knowledge_documents
          └─< tasks ─┬─< task_dependencies (task/depends_on)
                     ├─< task_events >── roles, agents
                     ├─< agent_runs >── agents, roles ─< context_snapshots
                     ├─< pipeline_runs ─< pipeline_stages
                     ├─< reviews >── agents
                     ├─< deployments >── services
                     ├─< artifacts
                     ├─< scanner_dispatches
                     └─< context_snapshots >── projects, services

roles ─┬─< agents
       ├─< prompts (версии)
       └─< tasks.current_role_id
```

Обозначения: `A ─< B` — у A много B; `B >── C` — B ссылается на C (FK).

---

## 3. ENUM-типы

| Тип | Значения |
|-----|----------|
| `task_status` | BACKLOG, READY, ARCHITECTURE, DECOMPOSITION, CODING, TESTING, FAILURE_ANALYSIS, REVIEW, COMMIT, DEPLOY, DONE, BLOCKED, FAILED, CANCELLED |
| ~~`task_priority`~~ | удалён миграцией 0047 (TASK-PRIORITY-SCALE-001); priority теперь SMALLINT 0..3 |
| `agent_run_status` | PENDING, RUNNING, SUCCESS, FAILED, TIMEOUT, CANCELLED |
| `event_type` | TASK_CREATED, TASK_UPDATED, STATUS_CHANGED, ROLE_ASSIGNED, AGENT_ASSIGNED, AGENT_STARTED, AGENT_FINISHED, PIPELINE_STARTED, PIPELINE_FAILED, PIPELINE_SUCCEEDED, REVIEW_REQUESTED, REVIEW_APPROVED, REVIEW_REJECTED, REVIEW_NEEDS_FIX, SERVICE_LOCKED, SERVICE_UNLOCKED, DEPLOY_STARTED, DEPLOY_COMPLETED, DEPLOY_FAILED, TASK_BLOCKED, TASK_DONE, TASK_CANCELLED |
| `pipeline_status` | PENDING, RUNNING, SUCCESS, FAILED, CANCELLED |
| `stage_status` | PENDING, RUNNING, SUCCESS, FAILED, SKIPPED |
| `review_status` | APPROVED, REJECTED, NEEDS_FIX |
| `deployment_status` | PENDING, RUNNING, SUCCESS, FAILED, ROLLED_BACK |
| `deployment_env` | DEV, STAGING, PROD |
| `artifact_type` | diff, patch, report, pipeline_log, review_report, test_report, build_log, screenshot, other |
| `document_type` | PROJECT_MAP, API_MAP, DATABASE_MAP, DECISIONS, ARCHITECTURE |
| `service_dep_type` | GRPC, REST, EVENT, DB, SYNC, ASYNC |

---

## 4. Таблицы

### projects
Список проектов. `code` уникален (PS, CHAT, IAM, WEBSTORE, PS_TORG).

| Поле | Тип | Примечание |
|------|-----|-----------|
| id | uuid PK | |
| code | text UNIQUE | |
| name | text | |
| description | text | |
| created_at | timestamptz | |

### services
Микросервисы проекта. Уникальность `(project_id, service_code)`.

| Поле | Тип | Примечание |
|------|-----|-----------|
| id | uuid PK | |
| project_id | uuid → projects | ON DELETE CASCADE |
| service_code | text | |
| service_name | text | |
| description | text | |
| repository_path | text | |
| created_at | timestamptz | |

### roles
Роли/этапы пайплайна. `sort_order` задаёт порядок.

| Поле | Тип |
|------|-----|
| id | uuid PK |
| code | text UNIQUE |
| name | text |
| description | text |
| sort_order | int |
| is_mcp_role | boolean NOT NULL DEFAULT false — роль доступна через MCP (раздел «MCP роли») |
| requirements | text NULL — требования к MCP-роли (свободный текст: доступы, данные, ограничения) |

Частичный индекс `idx_roles_is_mcp_role ON roles(is_mcp_role) WHERE is_mcp_role = true` (миграция 0041).

### agents
Конкретные ИИ, привязаны к роли.

| Поле | Тип | Примечание |
|------|-----|-----------|
| id | uuid PK | |
| code | text UNIQUE | |
| name | text | |
| provider | text | anthropic / openai / ... |
| model | text | |
| role_id | uuid → roles | ON DELETE SET NULL |
| is_active | boolean | |
| created_at | timestamptz | |

### prompts
Версионируемые промты ролей. **Старые версии не удаляются.**
Уникальность `(role_id, version)`; частичный уникальный индекс
`uq_prompts_active_per_role` гарантирует один активный промт на роль.

| Поле | Тип |
|------|-----|
| id | uuid PK |
| role_id | uuid → roles |
| version | int |
| prompt_text | text |
| is_active | boolean |
| created_at | timestamptz |

### tasks
Главная таблица. `updated_at` поддерживается триггером.

| Поле | Тип | Примечание |
|------|-----|-----------|
| id | uuid PK | |
| project_id | uuid → projects | CASCADE |
| service_id | uuid → services | SET NULL |
| parent_task_id | uuid → tasks | SET NULL (подзадачи) |
| title | text | |
| description | text | |
| priority | smallint | NOT NULL DEFAULT 2, CHECK 0..3 (TASK-PRIORITY-SCALE-001: меньше = важнее; 0 — только проект оркестратора, форс сервера; 1 высший польз., 2 обычный, 3 низкий) |
| status | task_status | DEFAULT BACKLOG |
| current_role_id | uuid → roles | SET NULL |
| assigned_agent_id | uuid → agents | SET NULL |
| intake_integration_id | uuid → intake_integrations | SET NULL; NULL = задача из другого канала (INTAKE-INTEGRATIONS-001) |
| created_by | text | |
| created_at / updated_at | timestamptz | |

### task_dependencies
Граф зависимостей задач. UNIQUE `(task_id, depends_on_task_id)`,
CHECK `task_id <> depends_on_task_id`.

### task_events  *(append-only)*
Полная история жизненного цикла. Триггер `task_events_immutable`
запрещает UPDATE/DELETE.

| Поле | Тип |
|------|-----|
| id | uuid PK |
| task_id | uuid → tasks |
| event_type | event_type |
| from_status / to_status | task_status |
| role_id | uuid → roles |
| agent_id | uuid → agents |
| payload_json | jsonb |
| created_at | timestamptz |

### agent_runs
Каждый запуск агента — контроль расходов/эффективности.

| Поле | Тип |
|------|-----|
| id | uuid PK |
| task_id | uuid → tasks |
| agent_id | uuid → agents (RESTRICT) |
| role_id | uuid → roles |
| status | agent_run_status |
| started_at / finished_at | timestamptz |
| input_json / output_json | jsonb |
| error_text | text |
| token_input / token_output | bigint |
| cost | numeric(14,6) |
| snapshot_connector_id | uuid → connectors ON DELETE SET NULL |
| snapshot_provider | text |
| snapshot_model | text |
| snapshot_driver_type | text |

`snapshot_*` fields store the connector/provider/model/driver snapshot used for
the run. Existing historical rows can keep `NULL` values in these fields.

### service_locks
Блокировки сервисов. Частичный уникальный индекс
`uq_service_locks_active` (WHERE `released_at IS NULL`) гарантирует
**не более одного активного лока на сервис**. Просроченные по `expires_at`
снимаются проставлением `released_at`.

| Поле | Тип |
|------|-----|
| id | uuid PK |
| service_id | uuid → services |
| task_id | uuid → tasks |
| locked_by_agent | uuid → agents |
| lock_reason | text |
| created_at / expires_at / released_at | timestamptz |

### service_dependencies
Граф зависимостей сервисов. UNIQUE `(source, target, type)`,
CHECK `source <> target`.

### pipeline_runs / pipeline_stages
Запуски Pipeline Service и их этапы (1 → N).

### scanner_dispatches
Идемпотентный журнал файлового Scanner bridge. UNIQUE
`(task_id, completion_key)` предотвращает повторный переход при повторной
доставке или переносе task document.

### reviews
Результаты ревью: `review_status` ∈ {APPROVED, REJECTED, NEEDS_FIX}.

### deployments
История деплоев по окружениям (`deployment_env`).

### artifacts
Артефакты задач (`artifact_type`): diff, patch, report, pipeline_log, ...

### knowledge_documents
Карты проекта (`document_type`). UNIQUE `(project_id, document_type)`,
`version` и `checksum` для отслеживания актуальности.

### intake_integrations
Реестр внешних приложений-источников обращений о проблемах — третий канал приёма
роли Task Intake Officer (INTAKE-INTEGRATIONS-001). БЕЗ обязательной привязки к
проекту (проект определяет сам Приёмщик). Миграция `0043_intake_integrations.sql`.

| Поле | Тип | Примечание |
|------|-----|-----------|
| id | uuid PK | `gen_random_uuid()` |
| name | text NOT NULL | уникально без учёта регистра (`lower(name)`) |
| token_hash | text NOT NULL DEFAULT '' | SHA-256 hex токена; наружу не отдаётся (флаг `has_token`); пусто = токен не выпущен |
| enabled | boolean NOT NULL DEFAULT true | включена/выключена |
| rate_limit_per_min | integer NOT NULL DEFAULT 60 | анти-спам: обращений/мин по интеграции |
| user_rate_limit_per_min | integer NOT NULL DEFAULT 20 | анти-спам: обращений/мин по пользователю |
| min_message_length | integer NOT NULL DEFAULT 10 | анти-спам: минимальная длина сообщения |
| created_at / updated_at | timestamptz NOT NULL DEFAULT now() | |

Ссылка на скриншот (объект MinIO) сохраняется в карточке задачи-обращения и
доступна следующим ролям.

### context_snapshots  *(immutable, append-only)*
Полный снимок контекста на момент запуска агента: воспроизводимость и
аудит решений ИИ. Триггер `context_snapshots_immutable` запрещает
UPDATE/DELETE. `snapshot_json` хранит полный контекст (документы, версии
карт, зависимости, промт, pipeline_config).

| Поле | Тип |
|------|-----|
| id | uuid PK |
| task_id | uuid → tasks |
| agent_run_id | uuid → agent_runs |
| project_id | uuid → projects |
| service_id | uuid → services |
| prompt_version | int |
| role_name / agent_name | text |
| project_map_version / database_map_version / api_map_version / architecture_version | int |
| snapshot_json | jsonb |
| created_at | timestamptz |

Цепочка восстановления: `Task → Agent Run → Context Snapshot → восстановление окружения`.

---

## 5. Индексы

`tasks(status)`, `tasks(service_id)`, `tasks(current_role_id)`,
`tasks(project_id)`, `tasks(parent_task_id)`, очередь выборок
`tasks(status, priority, created_at)` (TASK-PRIORITY-SCALE-001, миграция 0047:
priority — SMALLINT 0..3, меньше = важнее; 0 зарезервирован за проектом
оркестратора; сортировка priority ASC, затем created_at ASC — FIFO внутри приоритета);
`agent_runs(agent_id|task_id|status)`; `idx_agent_runs_day_provider_model`
(`date_trunc('day', started_at AT TIME ZONE 'UTC')`, `snapshot_provider`,
`snapshot_model`); `pipeline_runs(task_id)`;
`pipeline_stages(pipeline_run_id)`; `service_locks(service_id|task_id)`;
`task_events(task_id|created_at)`; `task_dependencies(task_id|depends_on)`;
`reviews(task_id)`; `deployments(task_id|service_id)`; `artifacts(task_id)`;
`context_snapshots(task_id|agent_run_id)`; `service_dependencies(source|target)`.

INTAKE-INTEGRATIONS-001 (миграция 0043): `intake_integrations_name_unique
(lower(name))`; `intake_integrations_token_hash_unique (token_hash) WHERE
token_hash <> ''`; идемпотентность обращений `uniq_tasks_integration_external
(intake_integration_id, external_id) WHERE обе не NULL`; старый
`uniq_tasks_unassigned_external` сужен до `WHERE project_id IS NULL AND external_id
IS NOT NULL AND intake_integration_id IS NULL`. Последовательность
`intake_report_seq` — человекочитаемый номер обращения.

---

## 6. Конкурентность (десятки агентов)

Безопасное распределение задач без конфликтов записи:

```sql
BEGIN;
SELECT *
FROM tasks
WHERE status = 'READY'
ORDER BY priority ASC, created_at ASC   -- priority SMALLINT: меньше = важнее (0 — оркестратор)
FOR UPDATE SKIP LOCKED
LIMIT 1;
-- ... перевести в IN_PROGRESS/CODING, назначить агента ...
COMMIT;
```

Захват сервиса под изменение:

```sql
INSERT INTO service_locks(service_id, task_id, locked_by_agent, lock_reason, expires_at)
VALUES (:service, :task, :agent, 'coding', now() + interval '30 min');
-- нарушение uq_service_locks_active => сервис уже занят
```

---

## 7. Гарантии аудита и истории

| Механизм | Что обеспечивает |
|----------|------------------|
| `task_events` (append-only trigger) | полная неизменяемая история переходов задач |
| `prompts` (версии, не удаляются) | история промтов |
| `context_snapshots` (immutable trigger) | воспроизводимость решений ИИ |
| `agent_runs` | расходы токенов/денег по каждому запуску |
| `tasks.updated_at` (trigger) | актуальная метка изменения |

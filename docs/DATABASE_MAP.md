# DATABASE_MAP.md

> Карта баз данных проекта. Подробная схема оркестратора — в
> [orchestrator-service/backend/db/DATA_MODEL.md](../orchestrator-service/backend/db/DATA_MODEL.md).

## orchestrator_db

- **Тип:** PostgreSQL 16 HA (Patroni); подключение через `pgbouncer:6432` и HAProxy.
- **Назначение:** единый источник истины оркестрации ИИ-агентов.
- **Подключение из Docker:** `postgresql://postgres:postgres@pgbouncer:6432/orchestrator_db`

### Таблицы (20)

| Таблица | Назначение |
|---------|-----------|
| `projects` | проекты |
| `services` | микросервисы проекта (`repository_path` — каталог сервиса относительно корня проекта; SERVICE-REPO-PATH-001: заполняется автоматически при авторегистрации и лениво бэкфиллится на claim PIPELINE_SERVICE; ранее мог быть NULL/устаревшим) |
| `roles` | роли/этапы пайплайна |
| `agents` | ИИ-агенты (провайдер, модель, роль) |
| `prompts` | версионируемые промты ролей |
| `tasks` | задачи (главная таблица) |
| `task_dependencies` | зависимости между задачами |
| `task_events` | append-only история жизненного цикла |
| `agent_runs` | запуски агентов (токены, стоимость) |
| `service_locks` | блокировки сервисов |
| `service_dependencies` | граф зависимостей сервисов |
| `pipeline_runs` | запуски pipeline |
| `pipeline_stages` | этапы pipeline |
| `reviews` | результаты ревью |
| `deployments` | история деплоев |
| `artifacts` | артефакты задач |
| `knowledge_documents` | карты проекта (этот каталог `docs/`) |
| `context_snapshots` | неизменяемые снимки контекста агента |
| `scanner_dispatches` | идемпотентный журнал завершений из task document |
| `intake_integrations` | внешние приложения-источники обращений (3-й канал Приёмщика) |

### Ключевые связи

```text
projects.id      → services.project_id, tasks.project_id, knowledge_documents.project_id
services.id      → tasks.service_id, service_locks.service_id,
                   service_dependencies.source/target, deployments.service_id
roles.id         → agents.role_id, prompts.role_id, tasks.current_role_id
agents.id        → tasks.assigned_agent_id, agent_runs.agent_id, reviews.reviewer_agent_id
tasks.id         → task_dependencies, task_events, agent_runs, pipeline_runs,
                   reviews, deployments, artifacts, context_snapshots, scanner_dispatches
tasks.parent_task_id → tasks.id          (подзадачи)
pipeline_runs.id → pipeline_stages.pipeline_run_id
agent_runs.id    → context_snapshots.agent_run_id
```

### Основные индексы

`tasks(status)`, `tasks(service_id)`, `tasks(current_role_id)`,
очередь `tasks(status, priority, created_at)` (миграция 0047; сортировка
priority ASC, затем created_at ASC — priority SMALLINT 0..3, меньше = важнее,
0 зарезервирован для проекта оркестратора, FIFO внутри одного приоритета),
`agent_runs(agent_id)`, `pipeline_runs(task_id)`, `service_locks(service_id)`,
`task_events(task_id)`. Полный список — в DATA_MODEL.md §5.

Идемпотентность обращений (INTAKE-INTEGRATIONS-001): частичный уникальный
`uniq_tasks_integration_external (intake_integration_id, external_id)` WHERE обе
не NULL; старый `uniq_tasks_unassigned_external` сужен до
`WHERE project_id IS NULL AND external_id IS NOT NULL AND intake_integration_id IS NULL`
(scanner-задачи). Последовательность `intake_report_seq` — номер обращения.

### Гарантии целостности

- Уникальный активный лок на сервис: `uq_service_locks_active` (WHERE `released_at IS NULL`).
- Один активный промт на роль: `uq_prompts_active_per_role`.
- Append-only: триггеры на `task_events`, `context_snapshots`.
- Конкурентный захват задач: `FOR UPDATE SKIP LOCKED`.
- Одна доставка Scanner на задачу/completion: UNIQUE `(task_id, completion_key)`.
- Идемпотентность приёма обращений: UNIQUE `(intake_integration_id, external_id)`
  (`uniq_tasks_integration_external`). Токен интеграции уникален среди выпущенных
  (`intake_integrations_token_hash_unique`, partial `WHERE token_hash <> ''`);
  имя интеграции уникально без учёта регистра (`lower(name)`).

---

## ER-диаграмма (текст)

```text
projects ─┬─< services ─┬─< service_dependencies (source/target)
          │             ├─< service_locks >── agents
          │             └─< tasks.service_id
          ├─< knowledge_documents
          └─< tasks ─┬─< task_dependencies
                     ├─< task_events
                     ├─< agent_runs ─< context_snapshots
                     ├─< pipeline_runs ─< pipeline_stages
                     ├─< reviews
                     ├─< deployments
                     └─< artifacts

roles ─┬─< agents
       ├─< prompts
       └─< tasks.current_role_id
```

---

## Внешние БД (инфраструктура)

В том же кластере `infra-postgres-1` живут БД других сервисов платформы
(`iam_db`, `chat_db`, `catalog`/`master_data`, `connector_db`, `psweb`, …).
Оркестратор с ними **не работает напрямую** — только через свои таблицы
`services` / `service_dependencies` как метаданные.

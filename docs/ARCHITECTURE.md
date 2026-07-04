# ARCHITECTURE.md

> Архитектура AI Orchestrator. Источник контекста для архитектора, ревьюера и
> аналитика ошибок.

## 1. Общая идея

Оркестратор управляет десятками ИИ-агентов, проводя каждую задачу по пайплайну
ролей. **PostgreSQL (`orchestrator_db`) — единственный источник истины.** Состояние
не хранится в памяти агентов: любой агент восстанавливает контекст из БД и
документов `docs/`.

## 2. Слои системы

```text
        Frontend (ai-dev-manager, :4186)
                  │
                  ▼
            Orchestrator (ядро)
        ┌─────────┼───────────────┐
        ▼         ▼               ▼
   orchestrator_db   tester-service   scanner-service
   (PostgreSQL)      (:4187)          (Claude task document)
                       │
                       ▼
                 pipeline-runner
              (.pipeline.json ИЛИ конвенция)
                       │
                       ▼
              Целевые микросервисы / БД
```

## 3. Пайплайн задачи

```text
Backlog
  ↓ Architect                (проектирование решения)
  ↓ Decomposer               (разбиение на подзадачи)
  ↓ Programmer               (реализация кода)
  ↓ Scanner                  (статус «выполнено» → событие оркестратора)
  ↓ Task Reviewer            (ревью изменений до pipeline)
  ↓ Pipeline Service         (tester-service → pipeline-runner)
  ↓ Failure Analyst          (только при падении; возврат к Programmer)
  ↓ Documentation Auditor    (проверка актуальности документации)
  ↓ Documentation Keeper     (только если нужны обновления)
  ↓ Git Integrator           (фиксация проверенных изменений)
Done
```

Каждая роль независима. Все переходы фиксируются в `task_events`
(append-only). Перед запуском любого агента создаётся `context_snapshot`.

**Fan-out Архитектора по сервисам (ARCH-SERVICE-SPLIT-001, ADR-013).** При
вердикте `FORWARD`, если разбивка Архитектора регистронезависимо резолвит **≥2
разных зарегистрированных сервиса** проекта, шаг Architect не линеен: исходная
задача становится эпиком (`task_kind='epic'`, `status='WAITING_FOR_CHILDREN'`), а
на каждый затронутый сервис материализуется независимая дочерняя задача
(`task_kind='service'`, свой `service_id`). Каждая дочерняя задача проходит
конвейер (`Programmer → … → Git Integrator`) **отдельно**; эпик закрывается
роллапом после того, как все дети терминальны. При 0 или 1 сервисе шаг остаётся
линейным (одна задача Programmer; 0 сервисов → `BLOCKED`).

## 4. Потоки данных

1. **Выбор задачи.** Оркестратор берёт задачу `status='READY'` через
   `FOR UPDATE SKIP LOCKED` — параллельные воркеры не конфликтуют.
2. **Снимок контекста.** Создаётся `context_snapshots` (промт, версии карт,
   зависимости, `.pipeline.json`).
3. **Запуск Programmer.** Для Claude Code задача публикуется в
   `tasks/claude-tasks.json`; завершение отмечается статусом `выполнено`.
4. **Scanner bridge.** scanner-service передаёт completion ровно один раз,
   сверяет задачу/проект/сервис через API и направляет её Task Reviewer.
5. **Тестирование.** tester-service запускает pipeline-runner; результаты →
   `pipeline_runs` / `pipeline_stages`, артефакты → `artifacts`.
6. **Падение.** При `failed` управление уходит к Аналитику ошибок; событие
   `PIPELINE_FAILED`.
7. **Документация/Git.** После успешного pipeline документация проверяется и при
   необходимости обновляется; затем Git Integrator создаёт итоговый commit.
8. **Расщепление Архитектора.** При `FORWARD`-вердикте с ≥2 затронутыми
   зарегистрированными сервисами исходная задача превращается в эпик
   (`WAITING_FOR_CHILDREN`), а на каждый сервис создаётся независимая задача-на-
   сервис (`task_kind='service'`); пишется `STATUS_CHANGED`
   (`reason='architect_service_split'`, payload — созданные `{id, serviceCode}` и
   `unresolved`). Каждая дочерняя задача идёт по конвейеру независимо; эпик
   закрывается роллапом после терминальности всех детей (ADR-013).

## 5. Границы ответственности

| Компонент | Отвечает | Не отвечает |
|-----------|----------|-------------|
| Orchestrator | распределение задач, переходы статусов, блокировки | бизнес-логика сервисов |
| tester-service | запуск pipeline, возврат сырого результата | анализ кода/ошибок |
| pipeline-runner | выполнение этапов из `.pipeline.json` или построение стадий по конвенции (детект стека go/node и подсистемы compose по пути сервиса) | бизнес-логику сервисов |
| scanner-service | наблюдение за task document, exactly-once доставка completion | анализ или изменение кода |
| Failure Analyst | причина падения → задача программисту | правка кода |
| orchestrator_db | хранение состояния и истории | выполнение логики |

## 6. Параллелизм и блокировки

- Задачи распределяются через `SELECT ... FOR UPDATE SKIP LOCKED`.
- Один сервис изменяется одним агентом: `service_locks` + частичный уникальный
  индекс (`released_at IS NULL`).
- Запуски pipeline изолированы (свой `runId`-каталог), глобальных блокировок нет.

## 7. Карта зависимостей сервисов

```text
Chat_Service ──GRPC──> IAM_Service
Catalog_Service ──GRPC──> IAM_Service
Chat_Service ──REST──> Connector_Service
```

Хранится в `service_dependencies`; используется для порядка изменений и
предотвращения ломающих правок.

## 8. Внешние интеграции

- **AI-провайдеры:** Anthropic (Claude), OpenAI (Codex) — через `agents`.
- **Инфраструктура Docker:** PostgreSQL, Redis, MinIO, pgAdmin.
- **Виджет «Обратная связь» SPA** (ORCH-FEEDBACK-WIDGET-001, коммит `8cbc0aa`):
  плавающая кнопка на всех страницах фронтенда (`src/App.tsx` →
  `src/features/feedback/FeedbackWidget.tsx`) собирает обращение (категория,
  текст, скриншот через `html2canvas`, автоконтекст с буфером JS-ошибок) и шлёт
  его same-origin на общий backend оркестратора. Принцип: **все виджеты обратной
  связи проходят через общий backend оркестратора**, который серверно подставляет
  токен интеграции «orchestrator-ui» и переиспользует приём обращений
  INTAKE-INTEGRATIONS-001 → задача сразу в `BACKLOG` под Приёмщиком. Backend
  реализован (FEEDBACK-WIDGET-001) модулем
  `orchestrator-service/backend/src/feedback.js` (`acceptFeedback` →
  `acceptIntakeReport`) с роутами `/api/feedback`, `/api/feedback/screenshot` и
  `GET /api/feedback/screenshot/:id` в `server.js`; контракт — в API_MAP.md.

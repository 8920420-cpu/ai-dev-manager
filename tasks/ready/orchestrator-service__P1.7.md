---
id: ORCHESTRATOR-P1.7
status: ready
service: ORCHESTRATOR
priority: P1
initiative: MCP-TASK-BRIDGE-001
owner: orchestrator-service
depends_on: []
---

# P1.7 MCP-TASK-BRIDGE-001 — MCP-инструменты для работы Claude Code с задачами из Postgres без scanner bridge

## Description

Реализовать управляемую схему, в которой Claude Code из VS Code берет задачи из Postgres через MCP tools, выполняет их и возвращает результат обратно в БД, после чего оркестратор продолжает цепочку ролей без файлового scanner bridge.

Нужно не давать AI прямой SQL-доступ к Postgres, а расширить существующий API-инструментарий отдельным доменным модулем task tools. MCP-слой должен быть тонким адаптером над теми же сервисными функциями, которые используют REST/API endpoints, чтобы не появилось две независимые реализации жизненного цикла задач.

## Scope

- `orchestrator-service/backend/src/db.js`
- `orchestrator-service/backend/src/server.js`
- новый backend-модуль для task tools / MCP adapter, если нужен
- `orchestrator-service/backend/db/migrations/*`, если текущей схемы недостаточно
- `orchestrator-service/backend/db/DATA_MODEL.md`
- `orchestrator-service/backend/docs/*`
- `docs/API_MAP.md`, `docs/ARCHITECTURE.md`, `docs/DATABASE_MAP.md`
- `roles/programmer.md`, `roles/scanner.md`, если меняется рабочий контракт
- backend-тесты в `orchestrator-service/backend/test/*`

Не менять frontend, pipeline-runner, scanner-service и host-runner в этой задаче, кроме документации контрактов. Их адаптация должна быть отдельными задачами, если после backend-контракта потребуются изменения.

## Pre-coding brief (готовит оркестратор)

- Архитектурное решение: расширяем существующий orchestrator-service, а не создаем отдельный сервис инструментов.
- Postgres остается источником истины для задач, статусов, назначений, запусков агентов и событий.
- Claude Code не получает инструмент вида `sql.query`, `db.select` или прямой доступ к таблицам. Доступ только через бизнес-команды.
- MCP tools должны вызывать общий service layer, а не дублировать SQL рядом с MCP-транспортом.
- Scanner bridge после этой задачи не удаляется физически, но новый контракт должен позволять не использовать `runtime/claude-tasks.json` и `/api/scanner/task-completed` для Claude Code.
- Все изменения схемы БД требуют отдельного явного подтверждения пользователя перед фактическим запуском миграций, согласно корневому `TASKS.md`.
- Блокировки должны быть атомарными. Для конкурентного claim использовать транзакцию с `FOR UPDATE SKIP LOCKED` или эквивалентный атомарный `UPDATE ... RETURNING`.
- Повторная доставка результата должна быть идемпотентной: повтор `complete_task` с тем же run/completion key не должен дважды продвигать задачу по pipeline.
- MCP-инструменты не должны возвращать секреты, полные connector tokens, лишние prompt dumps или чужие результаты соседних задач.

## Tool contract

Добавить доменный набор инструментов, доступный через MCP adapter и, при необходимости, через существующий REST API для тестирования:

- `task.claim_next`
  - Вход: `{ agentId, roleCode?, projectId?, serviceId?, capabilities?, leaseSeconds? }`.
  - Поведение: атомарно выбирает следующую доступную задачу для роли `PROGRAMMER` или указанной разрешенной роли, назначает агента, создает/обновляет `agent_runs`, пишет `task_events`.
  - Выход: `{ task: null }` или `{ task: { id, project, service, title, description, priority, status, currentRole, context, leaseExpiresAt, agentRunId } }`.

- `task.get`
  - Вход: `{ taskId }`.
  - Поведение: возвращает только разрешенный контекст задачи, последние релевантные события и данные текущего agent run.
  - Выход не содержит секреты и не смешивает контекст других задач.

- `task.append_log`
  - Вход: `{ taskId, agentRunId?, level?, message, payload? }`.
  - Поведение: пишет append-only событие или run log без изменения статуса.
  - Используется для промежуточной наблюдаемости Claude Code.

- `task.complete`
  - Вход: `{ taskId, agentRunId, completionKey, result, changedFiles, summary?, artifacts? }`.
  - Поведение: идемпотентно завершает текущий run, сохраняет результат, переводит задачу на следующий статус/роль по существующему role pipeline, снимает назначение агента и пишет `task_events`.
  - Повтор с тем же `completionKey` возвращает уже зафиксированный результат без второго перехода.

- `task.fail`
  - Вход: `{ taskId, agentRunId, error, errorType?, retryable?, changedFiles? }`.
  - Поведение: завершает run как failed, переводит задачу в `BLOCKED`, `FAILED` или на failure-analysis согласно существующему pipeline, пишет событие с машинным кодом ошибки.

- `task.release`
  - Вход: `{ taskId, agentRunId?, reason }`.
  - Поведение: освобождает claim, если задача не terminal и claim принадлежит текущему агенту/run, пишет audit event.

- `task.heartbeat`
  - Вход: `{ taskId, agentRunId }`.
  - Поведение: продлевает lease активного run, чтобы watchdog не вернул задачу в очередь во время долгой работы.

## Tasks

- Выделить общий service layer для операций claim/get/log/complete/fail/release/heartbeat, чтобы REST и MCP adapter использовали одну реализацию.
- Реализовать MCP adapter с инструментами из `Tool contract`. Если в проекте уже есть механизм регистрации AI tools, расширить его отдельным namespace `task.*`; не создавать параллельную несовместимую систему.
- Зафиксировать machine-readable ошибки минимум: `task_not_found`, `task_not_claimed`, `task_claim_conflict`, `task_terminal`, `agent_run_not_found`, `completion_key_required`, `completion_duplicate`, `invalid_role`, `lease_expired`, `permission_denied`.
- Добавить lease/heartbeat модель, если текущей схемы `agent_runs` и `tasks.assigned_agent_id` недостаточно. Миграция должна быть минимальной и обратно совместимой.
- Реализовать watchdog-функцию на уровне orchestrator-service, которая освобождает просроченные claims без scanner bridge и пишет audit event. Это не файловый scanner.
- Сохранить совместимость существующих endpoints `/api/runner/next-claude-task`, `/api/runner/release-claude-task`, `/api/scanner/task-completed` на время переходного периода; новая реализация не должна ломать текущие тесты.
- Обновить документацию архитектуры: новый поток `Claude Code -> MCP tools -> orchestrator-service -> Postgres -> role pipeline`.
- Обновить документацию API/DB: описать lifecycle, поля claim/lease/completion, идемпотентность и запрет прямого SQL-инструмента.
- Обновить роль `programmer.md`: Claude Code получает и возвращает задачу через MCP task tools; файловый `claude-tasks.json` остается legacy fallback до отдельной задачи удаления scanner bridge.
- Обновить роль `scanner.md`: пометить файловый bridge как legacy/fallback, не как основной путь для Claude Code.
- Добавить unit/contract-тесты для конкурентного claim, complete, duplicate complete, fail, release, heartbeat и lease timeout.
- Добавить тест, подтверждающий, что два параллельных агента не получают одну задачу.
- Добавить тест, подтверждающий, что `complete` переводит задачу ровно на следующий pipeline status/role и очищает `assigned_agent_id`.
- Добавить тест, подтверждающий, что MCP adapter вызывает service layer, а не содержит отдельную SQL-логику.

## Acceptance

- Claude Code может получить задачу через `task.claim_next`, увидеть достаточный контекст через `task.get`, записать промежуточный лог через `task.append_log` и завершить задачу через `task.complete`.
- После `task.complete` задача в Postgres получает следующий статус/роль по существующему pipeline, а не зависает в состоянии Programmer.
- Scanner bridge не участвует в основном happy path нового Claude Code flow.
- Повторный `task.complete` с тем же `completionKey` не создает повторный `task_events` переход и не запускает следующий этап второй раз.
- Два одновременных `task.claim_next` для одной очереди не могут вернуть одну и ту же задачу.
- Просроченный claim освобождается watchdog-логикой, но активный claim с heartbeat не освобождается.
- Ошибки возвращаются стабильными машинными кодами и пригодны для автоматической обработки AI-клиентом.
- Секреты connector/API tokens и полный приватный prompt history не возвращаются через MCP task tools.
- Старые runner/scanner endpoints остаются работоспособными в тестах, пока отдельная задача не удалит legacy bridge.
- Документация явно описывает, что прямой Postgres/SQL tool для AI запрещен.

## Orchestrator validation

- `npm test` в `orchestrator-service/backend`.
- Проверить отдельным интеграционным сценарием:
  1. создать/найти задачу в `READY`/`CODING` для `PROGRAMMER`;
  2. вызвать `task.claim_next`;
  3. вызвать `task.get`;
  4. вызвать `task.append_log`;
  5. вызвать `task.complete`;
  6. убедиться по `tasks`, `agent_runs`, `task_events`, что статус, run и audit trail согласованы.
- Проверить конкурентный claim двумя параллельными клиентами.
- Проверить duplicate completion с тем же `completionKey`.
- Проверить отсутствие scanner bridge обращений в новом happy path.

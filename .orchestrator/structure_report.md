# Structure Report — ai-dev-manager

- **Сервис:** AI_DEV_MANAGER (проект ai-dev-manager)
- **Дата запуска:** 2026-06-22
- **Версия структуры проекта:** 1.0.0
- **Версия эталона:** 1.0.0
- **Статус:** READY

## Созданные папки

- `tasks/inbox/`, `tasks/ready/`, `tasks/in_progress/`, `tasks/review/`, `tasks/qa/`,
  `tasks/blocked/`, `tasks/done/`, `tasks/archive/`
- `tasks/archive/legacy-service-queues/`
- `.orchestrator/`, `_orchestrator/`, `_orchestrator_template/` (эталон и глобальное состояние)

## Созданные файлы

- `.orchestrator/`: `version.json`, `service.json`, `locks.json`, `last_scan.json`, `migrations.log`,
  `structure_report.md`
- `_orchestrator/`: `services_registry.json`, `dependencies.json`, `README.md`
- `tasks/`: `README.md` (папочная модель), `TASK.template.md`
- 25 индивидуальных task-файлов в `ready/` (13), `review/` (10), `blocked/` (2)

## Миграции

- `0.0.0 → 1.0.0` (bootstrap): приведение проекта к эталону структуры 1.0.0 — OK

## Перемещённые задачи

- 25 задач из прежних сервисных очередей разложены по стадиям:
  - `ready/` — 13 (orchestrator P1.2/P1.3/P1.4/P2.2/P2.3, frontend P1.3, pipeline-runner P1.2/P2.1,
    integration P2.1–P2.4/P3.1)
  - `review/` — 10 (orchestrator P0.1/P1.1/P2.1, frontend P0.1/P1.1/P1.2/P2.1/P2.2,
    pipeline-runner P1.1, scanner-service P1.1)
  - `blocked/` — 2 (scanner-service P1.2, P2.1)
- Legacy-файлы перенесены в `tasks/archive/legacy-service-queues/`.

## Найденные проблемы

- Зарегистрированные сервисы (`ORCHESTRATOR`, `FRONTEND`, `PIPELINE_RUNNER`, `SCANNER`, `TESTER`) ещё не
  имеют собственных каталогов `.orchestrator/` и комплекта документации эталона — будут созданы при
  первом запуске Structure Keeper по каждому сервису.

## Требуемые ручные действия

- Заполнить шаблоны документации (`PROJECT_MAP.md`, `ARCHITECTURE.md`, `API_MAP.md`, `DATABASE_MAP.md`,
  `DECISIONS.md`) для сервисов фактическим содержанием.

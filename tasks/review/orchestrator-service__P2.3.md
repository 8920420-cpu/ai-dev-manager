---
id: ORCHESTRATOR-P2.3
status: ready
service: ORCHESTRATOR
priority: P2
initiative: LEGACY-STAGE-DEFAULTS-001
owner: orchestrator-service
depends_on: ["все сохранённые `project_stages` и pipeline-конфигурации должны быть переведены на явный `enabled`; запись в БД требует отдельного подтверждения"]
---

# P2.3 LEGACY-STAGE-DEFAULTS-001 — удалить совместимость этапов без `enabled`

## Description

Удалить совместимость этапов без `enabled`.

## Scope

- backend stage API/model/validation, read-only audit и migration после подтверждения, соответствующие тесты и контрактная документация.

## Pre-coding brief (готовит оркестратор)

- До Programmer предоставить результаты read-only аудита, точный migration/rollback и подтверждение готовности pipeline-runner P2.1.
- Канонический контракт требует boolean `enabled`; отсутствие поля после миграционного окна является 422-ошибкой.

## Tasks

- Добавить аудит данных и миграционный отчёт для этапов без `enabled`; изменение данных выполнять только после отдельного подтверждения пользователя.
- После миграции сделать `enabled` обязательным в API/доменной модели и удалить `stage?.enabled !== false` как fallback старых данных.
- Отклонять неполный контракт стабильной ошибкой вместо неявного включения этапа; обновить документацию и contract-тесты.

## Acceptance

- Все этапы содержат явный boolean `enabled`; runtime не имеет ветки совместимости «отсутствует = true».

## Orchestrator validation

- `npm test` в `orchestrator-service/backend`.
- После отдельного подтверждения выполнить migration, повторный аудит и rollback rehearsal.
- Integration P3.1 подтверждает отказ старого контракта и работу канонического E2E.

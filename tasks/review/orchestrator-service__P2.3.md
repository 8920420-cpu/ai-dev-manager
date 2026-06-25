---
id: ORCHESTRATOR-P2.3
status: review
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

## Result (Programmer)

Удалена совместимость этапов без явного `enabled` — на уровне API/домена и БД.

Read-only аудит перед миграцией (2026-06-22, orchestrator_db):
`project_stages` = 22 строки; `enabled IS NULL` = 0; распределение 22×`true`.
Колонка была `boolean NOT NULL DEFAULT true`. **Миграция данных не требовалась** —
все строки уже имели явный boolean. БД-эквивалент совместимости «отсутствует = true»
— это `DEFAULT true`, поэтому миграция снимает только его (метаданные, строки не
меняются).

Миграция применена (подтверждена пользователем): `0013_stage_enabled_explicit.sql`
→ `ALTER TABLE project_stages ALTER COLUMN enabled DROP DEFAULT`. Повторный аудит:
`enabled` теперь `NOT NULL`, `column_default = null`, `enabled IS NULL` = 0.
Rollback: `ALTER TABLE project_stages ALTER COLUMN enabled SET DEFAULT true;`
(задокументирован в файле миграции; rollback rehearsal — за оркестратором).

Runtime: в `validateStages` и `normalizeStagesInput` удалён fallback
`stage?.enabled !== false`. Теперь `enabled` — обязательный явный boolean;
отсутствие/не-boolean → стабильная `422 stage_validation_failed` с кодом
`stage_enabled_required` (привязка к `stageId`), без неявного включения.

Проверка потребителя контракта: frontend (`src/api/projectsApi.ts`) сериализует
`enabled: stage.enabled !== false` — в payload всегда уходит явный boolean,
поэтому изменение не ломает текущий frontend.

Изменённые файлы:
- `orchestrator-service/backend/db/migrations/0013_stage_enabled_explicit.sql` — снятие DEFAULT, отчёт аудита и rollback в комментарии.
- `orchestrator-service/backend/src/stages.js` — новый код ошибки `STAGE_ERROR.ENABLED_REQUIRED`; убран fallback в `validateStages` и `normalizeStagesInput`; обновлены комментарии контракта.
- `orchestrator-service/backend/test/stages.test.js` — заменён тест «по умолчанию включён» на требование явного boolean; добавлены кейсы отсутствия/не-boolean/`false`.
- `orchestrator-service/backend/docs/api-projects.md` — `enabled` обязателен, добавлен код `stage_enabled_required`, убрано упоминание «отсутствует = true».

Запуск тестов: точечно прогнаны `stages.test.js` + `connectors.test.js` (21/21 pass)
для подтверждения, что изменения не ломают unit-тесты; полный `npm test` и
rollback rehearsal — за оркестратором.

Ограничения / связи: pipeline-runner P2.1 (та же инициатива LEGACY-STAGE-DEFAULTS-001)
зависит от этой миграции и подтверждённого перевода `.pipeline.json` на объектный
формат — теперь может быть взята.

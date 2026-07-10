---
id: INTEGRATION-P3.1
status: ready
service: INTEGRATION
priority: P3
initiative: LEGACY-CLEANUP-E2E-001
owner: integration
depends_on: ["завершены legacy-задачи frontend, orchestrator-service, pipeline-runner и scanner-service; telemetry подтверждает нулевое legacy-использование"]
---

# P3.1 LEGACY-CLEANUP-E2E-001 — сквозная проверка удаления fallback-контрактов

## Description

сквозная проверка удаления fallback-контрактов

## Scope

- read-only inventory, migration/rollback orchestration после подтверждения и канонические/negative E2E; исправления product-кода оформляются отдельными сервисными задачами.

## Pre-coding brief (готовит оркестратор)

- Подготовить полный inventory потребителей, backup/restore команды, критерии rollback и отдельный запрос подтверждения любых записей/миграций БД.
- Зафиксировать канонические контракты и ожидаемые стабильные ошибки каждого удалённого fallback.

## Tasks

- До удаления собрать инвентаризацию реальных проектов, pipeline-конфигов, Scanner env и payload `/invoke`; зафиксировать владельца и план миграции каждого найденного потребителя.
- Выполнить миграции с резервной копией и проверяемым rollback; любые записи в БД запускать только после отдельного подтверждения пользователя.
- Пройти E2E только по каноническим путям: серверные бизнес-данные, `{ user }`, обязательный `enabled`, multi-watcher Scanner без feeder bridge.
- Добавить отрицательные проверки старых контрактов: localStorage не влияет на данные, `{ prompt }`, массив stage и legacy env Scanner отклоняются диагностируемо.
- Удалить feature flags и временную telemetry legacy-использования только после согласованного периода нулевых обращений.

## Acceptance

- Поиск production-кода не находит удалённые fallback-ветки; канонический E2E проходит, старые контракты не активируются молча.
- Есть отчёт миграции и rollback-проверки, подтверждающий отсутствие потери проектов, настроек этапов и назначений ролей.

## Orchestrator validation

- До записи выполнить inventory и migration preview; после отдельного подтверждения — backup, migration, audit и rollback rehearsal.
- Запустить все сервисные unit suites и канонический/negative E2E минимум дважды; сохранить отчёт без секретов.

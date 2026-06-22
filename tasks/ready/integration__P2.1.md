---
id: INTEGRATION-P2.1
status: ready
service: INTEGRATION
priority: P2
initiative: PIPELINE-STAGE-CONFIG-001
owner: integration
depends_on: ["завершены соответствующие P0.1/P1.1 в orchestrator-service, frontend, pipeline-runner и scanner-service"]
---

# P2.1 PIPELINE-STAGE-CONFIG-001 — E2E отключения этапов и настройки Scanner

## Description

E2E отключения этапов и настройки Scanner

## Scope

- сквозные contract/E2E fixtures и тесты; product-код сервисов не исправлять из этой задачи.

## Pre-coding brief (готовит оркестратор)

- Зафиксировать версии сервисов, тестовые каталоги/mount mapping, исходные данные и способ очистки без воздействия на пользовательские данные.
- Любая запись в общей БД требует отдельного подтверждения; предпочтителен изолированный disposable test database.

## Tasks

- Поднять совместимые версии сервисов и проверить единый контракт `enabled`, role code `SCANNER`, `scanner.watchDirectory`, `SKIPPED` и код причины пропуска.
- Пройти E2E: создать проект, выбрать папку Scanner, отключить промежуточный этап, сохранить, перечитать проект и запустить pipeline.
- Подтвердить, что отключённый этап не запускает агента/команды, присутствует в истории как `SKIPPED`, а следующий включённый этап получает управление.
- Отключить Scanner и подтвердить остановку watcher и отсутствие completion; включить обратно и подтвердить восстановление сохранённой папки и exactly-once переход к следующему этапу.
- Проверить отрицательные сценарии: Scanner без папки, относительный/несуществующий/недоступный путь, отсутствующий Docker mount, ошибка API, смена папки во время наблюдения.
- Проверить обновление со старыми данными без `enabled`: все существующие этапы остаются включёнными, миграция/normalization не меняет порядок и роли.
- Проверить observability: UI показывает локальную ошибку, API — стабильный машинный код, scanner readiness — недоступность папки, runner summary/log — причину `disabled_by_configuration`.

## Acceptance

- E2E доказывает полный поток UI → API/storage → runner/scanner → история запуска без ручного исправления данных.
- Ни один отключённый этап не создаёт побочных эффектов, но остаётся видимым и повторно включаемым.
- Scanner невозможно сохранить включённым без папки; ошибка доступности папки после сохранения диагностируется scanner-service.
- Старые проекты продолжают выполняться без изменения поведения.
- Все contract/E2E-тесты стабильны при повторном запуске и не зависят от порядка тестов.

## Orchestrator validation

- Запустить backend/frontend/pipeline-runner/scanner unit suites, затем этот E2E минимум дважды.
- Сохранить артефакты API, readiness и runner summary; проверить cleanup watcher/process/test data.

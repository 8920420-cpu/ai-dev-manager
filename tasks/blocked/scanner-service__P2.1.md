---
id: SCANNER-P2.1
status: blocked
service: SCANNER
priority: P2
initiative: LEGACY-SCANNER-SINGLE-WATCHER-001
owner: scanner-service
depends_on: ["завершены P1.1/P1.2 Scanner; оркестратор подтвердил telemetry нулевого использования fallback и переход всех окружений на API-конфигурацию watcher"]
---

# P2.1 LEGACY-SCANNER-SINGLE-WATCHER-001 — удалить одиночный env/file bridge

## Description

удалить одиночный env/file bridge

## Scope

- legacy feeder/env ветки в `scanner-service/src/` и `bin/`, тесты; compose/README обновляют документационные/интеграционные роли.

## Pre-coding brief (готовит оркестратор)

Подтверждённая legacy-логика: `bin/scanner-service.js` напрямую собирает один watcher из `SCANNER_DOCUMENT`/`SCANNER_STATE`, выводит feeder endpoints строковой заменой `SCANNER_ENDPOINT` и запускает polling-мост `TaskFeeder`.

- До Programmer предоставить инвентаризацию окружений, период telemetry без legacy-вызовов и утверждённый rollback.
- Канонический запуск использует только конфигурацию `projectId + stageId` из orchestrator-service.

## Tasks

- После миграционного окна удалить вывод `apiBase` строковой заменой, `FEEDER_*` endpoints и одиночную сборку watcher из `SCANNER_DOCUMENT`/`SCANNER_STATE`.
- Удалить `TaskFeeder` и `/api/runner/next-claude-task`/release-клиент Scanner только после подтверждения, что канонический диспетчер Programmer полностью заменяет файловый обратный мост.
- Оставить явную диагностическую ошибку для устаревших env-переменных, чтобы неверная конфигурация не запускала частично рабочий режим.
- Обновить код health/readiness и тесты на multi-watcher lifecycle без legacy polling. Изменения compose и README передать последующим ролям оркестратора как `documentation_impact: REQUIRED`.

## Acceptance

- Scanner запускается только из канонической конфигурации этапов и не выводит endpoints из других URL.
- В production-коде отсутствуют `TaskFeeder`, `SCANNER_DOCUMENT`, `SCANNER_STATE` и `FEEDER_*`; несколько watcher изолированы по проекту/этапу.
- Повторный запуск, временная недоступность оркестратора и graceful shutdown покрыты integration-тестами без файлового обратного моста.

## Orchestrator validation

- `npm test` в `scanner-service`.
- Поиск production-кода и compose по legacy-символам; Integration P3.1 с multi-watcher, restart и временной недоступностью API.
- Проверить диагностический отказ при устаревших env и отсутствие фонового polling feeder.
- После проверки обновить compose и README через документационные/интеграционные роли оркестратора.

## Причина блокировки

Блокировка: зависит от завершённых Scanner P1.2 (ещё `[!]`) и подтверждённой оркестратором telemetry нулевого использования fallback. Удаление legacy single-watcher/feeder преждевременно.

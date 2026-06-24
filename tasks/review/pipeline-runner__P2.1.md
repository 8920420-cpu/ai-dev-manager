---
id: PIPELINE_RUNNER-P2.1
status: ready
service: PIPELINE_RUNNER
priority: P2
initiative: LEGACY-STAGE-DEFAULTS-001
owner: pipeline-runner
depends_on: ["tasks/orchestrator-service.md → P2.3 и подтверждённая оркестратором миграция всех `.pipeline.json` на объектный формат"]
---

# P2.1 LEGACY-PIPELINE-CONFIG-001 — удалить массивы команд и неявный `enabled`

## Description

удалить массивы команд и неявный `enabled`

## Scope

- `pipeline-runner/src/ConfigLoader.js`, примеры/генераторы pipeline-конфигурации и соответствующие тесты.

## Pre-coding brief (готовит оркестратор)

- Подтверждённая legacy-логика: `ConfigLoader.#normalizeStage` принимает массив команд и считает отсутствующий `enabled` равным `true`.
- До Programmer предоставить инвентаризацию всех `.pipeline.json`, preview преобразования и подтверждение, что старых активных потребителей не осталось.
- Канонический формат этапа: объект с обязательными `commands` и boolean `enabled`; старый формат отклоняется до запуска команды.

## Tasks

- Добавить read-only аудит конфигураций и конвертер preview старого массива в `{ "commands": [...], "enabled": true }`; не перезаписывать файлы без явного запуска.
- Перевести примеры, генераторы и потребителей на объектный формат с обязательным boolean `enabled`.
- После миграционного окна удалить ветку `Array.isArray(value)` и default `enabled = true`; неполный/старый формат завершать `ConfigError` с указанием этапа и инструкции миграции.
- Удалить тесты, закрепляющие старое поведение, и заменить их тестами отказа старого формата и обязательности `enabled`.

## Acceptance

- Runner принимает только объект `{ commands, enabled }`; старый массив и объект без `enabled` отклоняются до запуска команд.
- Все репозиторные конфигурации и примеры проходят аудит и production/integration-тесты.

## Orchestrator validation

- Повторить read-only аудит `.pipeline.json` и убедиться, что legacy-конфигураций нет.
- `npm test` в `pipeline-runner`.
- Integration P3.1: канонический конфиг выполняется, массив и объект без `enabled` диагностируемо отклоняются.

---
id: PIPELINE_RUNNER-P2.1
status: review
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

## Result (Programmer)

Удалена поддержка старого формата этапа в `ConfigLoader.#normalizeStage`:
убраны ветка `Array.isArray(value)` и default `enabled = true`. Канонический
формат — объект `{ "commands": string[], "enabled": true|false }`; оба поля
обязательны. Старый массив и объект без `enabled` отклоняются `ConfigError`
до запуска команд — с указанием имени этапа и инструкцией миграции.

Read-only инвентаризация `.pipeline.json` (3 файла):
- `./.pipeline.json` — был массивный формат → переведён в объектный (`enabled:true`).
- `./pipeline-runner/example/.pipeline.json` — был массивный → объектный (`enabled:true`).
- `./_orchestrator_template/.pipeline.json` — уже объектный (`build:true`, `deploy:false`, `smoke:false`), не менялся.
Все три проходят `ConfigLoader.load` после изменения (проверено).

Активные потребители контракта переведены на объектный формат:
- `host-runner/src/actions.js` (host-хелпер, не отдельный сервис реестра) — in-memory
  конфиг безопасного дефолта `{ 'unit-tests': { commands: [cmd], enabled: true } }`.
- `pipeline-runner/README.md` — пример stage-конфига обновлён, описан обязательный `enabled`.
Других потребителей старого формата нет: `orchestrator-service/pipelineDispatch.js`
лишь хранит имя файла; `tester-service` не зависит от формата значения этапа
(его `Array.isArray(json.stages)` — отдельная логика подсчёта, вне scope/сервиса TESTER).

Тесты:
- `pipeline-runner/test/ConfigLoader.test.js` — убраны тесты «массив → enabled=true» и
  «объект без enabled → true»; добавлены тесты отказа массивного формата и
  обязательности boolean `enabled`; валидные кейсы переведены на объектный формат.
- `pipeline-runner/test/helpers.js` — добавлен хелпер `stageMap` (компактная запись фикстур → канонический объектный формат с явным `enabled`).
- `pipeline-runner/test/integration.test.js`, `ServicePipelineTask.test.js` — фикстуры пишут конфиг через `stageMap` (объектный формат на диске).
  `PipelineRunner.test.js` и `StageRunner.test.js` не менялись: строят уже нормализованный конфиг, минуя ConfigLoader.

Запуск тестов: полный `node --test` в `pipeline-runner` — 60/60 pass. Дополнительно
проверена загрузка трёх репозиторных `.pipeline.json` новым ConfigLoader (все OK).
Полный `npm test` оркестратор повторит сам.

Зависимости: orchestrator P2.3 (та же инициатива) завершена, миграция БД применена;
все `.pipeline.json` переведены на объектный формат в рамках этой задачи.

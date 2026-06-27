---
id: ORCHESTRATOR-LEGACY-STAGE-DEFAULTS
status: blocked
service: orchestrator-service
priority: P3
initiative: LEGACY-STAGE-DEFAULTS-003
owner: orchestrator-service
depends_on: ["решение по контракту API stage.enabled (опускаемое поле = включён?)", "миграция данных project_stages + явный enabled во всех клиентах фронтенда"]
---

# LEGACY-STAGE-DEFAULTS — удалить совместимость «отсутствует = включён»

## Description

Снять legacy-совместимость контракта `enabled` этапа (`enabled !== false` /
absent = true) в backend `stages.js` и фронтенд-хелперах.

## Почему заблокировано (а не удалено в рамках «Remove audited legacy code paths»)

Это **не безопасное удаление мёртвого кода**, а изменение контракта, которое:

1. **Противоречит сознательному решению проекта.** Миграция
   `0013_stage_enabled_explicit.sql` (LEGACY-STAGE-DEFAULTS-001) сняла `DEFAULT true`
   и потребовала явный `enabled`. Затем `0024_stage_enabled_default_true.sql`
   (LEGACY-STAGE-DEFAULTS-002) **намеренно откатила** это и вернула
   `DEFAULT true` + контракт «отсутствует = включён». То есть текущая
   совместимость — действующее требование, а не забытый legacy.

2. **Меняет контракт API, а не только БД.** Колонка `project_stages.enabled` уже
   `NOT NULL DEFAULT true`; на уровне БД все строки имеют явный boolean
   (аудит 0013: 22 строки, NULL = 0). Оставшиеся `stage?.enabled !== false`
   ([orchestrator-service/backend/src/stages.js](../../orchestrator-service/backend/src/stages.js)
   строки ~114 и ~335) и фронтенд `isStageEnabled`
   ([src/types/project.ts](../../src/types/project.ts) строка ~78) — это
   **дефолт входного контракта**: клиент, опустивший `enabled`, получает
   «включён». Замена на `=== true` молча отключит этапы у любого клиента,
   присылающего payload без `enabled`.

## Требуемая миграция/проверка перед снятием

- Принять явное решение по контракту: либо `enabled` обязателен во всех payload
  (валидация 422 при отсутствии), либо дефолт сохраняется. Зафиксировать в
  BUSINESS/STAGE-контракте.
- Аудит данных: подтвердить `project_stages.enabled IS NULL = 0` (ожидаемо 0 при
  NOT NULL) и при необходимости миграция проставления явного true/false.
- Перевести всех клиентов фронтенда на явную передачу `enabled`
  (`projectsApi.ts`, `wizardState.ts`, карточки/строки этапов схемы).
- Только после этого заменить `!== false` на строгий boolean и согласованно
  обновить backend + frontend + типы + тесты.

## Acceptance (для будущей разблокированной задачи)

- В backend и frontend нет неявного `enabled !== false`; контракт `enabled`
  единый и документирован.
- Миграция данных (если требуется) применена; rollback описан.
- Тесты покрывают: payload без `enabled` ведёт себя по новому контракту явно.

## Статус в рамках текущей задачи

Пункт 4 аудита «Remove audited legacy code paths» **намеренно НЕ выполнен**:
удаление небезопасно и требует отдельной задачи с миграцией/решением по
контракту. Пункты 1–3 (backend legacy API, frontend `localStore.ts`, scanner
legacy single-watcher/feeder) выполнены.

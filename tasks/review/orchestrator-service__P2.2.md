---
id: ORCHESTRATOR-P2.2
status: review
service: ORCHESTRATOR
priority: P2
initiative: LEGACY-CONNECTOR-PROMPT-ALIAS-001
owner: orchestrator-service
depends_on: ["frontend P2.2 завершена; оркестратор должен подтвердить отсутствие остальных потребителей `{ prompt }` по telemetry/инвентаризации"]
---

# P2.2 LEGACY-CONNECTOR-PROMPT-ALIAS-001 — удалить alias `input.prompt`

## Description

Удалить alias `input.prompt`.

Подтверждённая legacy-логика: `invokeConnector` принимает `input.user ?? input.prompt`, а текущий frontend всё ещё отправляет `prompt`.

## Scope

- `orchestrator-service/backend/src/connectors.js`, связанные backend-тесты и API-документация.

## Pre-coding brief (готовит оркестратор)

- Канонический request содержит только `{ user }`; старый payload получает стабильную 422-ошибку.
- Содержимое prompt запрещено включать в telemetry и диагностические логи.

## Tasks

- Зафиксировать `user` как единственное входное пользовательское поле `/api/integrations/:id/invoke` и перевести всех внутренних/внешних потребителей.
- На ограниченное миграционное окно логировать метрику использования alias без содержимого prompt; после нулевого использования удалить чтение `input.prompt`.
- Возвращать стабильную ошибку для старого payload вместо молчаливого принятия и удалить тесты/документацию legacy-контракта.

## Acceptance

- В `invokeConnector` отсутствует fallback на `input.prompt`; `{ user }` работает, старый payload получает документированную 422-ошибку.

## Orchestrator validation

- `npm test` в `orchestrator-service/backend`.
- Поиск всех production-потребителей `/invoke` и E2E: `{ user }` успешен, `{ prompt }` отклонён, содержимое запроса отсутствует в логах.

## Result (Programmer)

Удалён legacy-alias `input.prompt` в `invokeConnector`. Теперь единственное
пользовательское поле — `user`; старый payload `{ prompt }` без `user`/`system`
получает стабильную `422 prompt_required` (не молчаливое принятие). Поле `prompt`
в request-теле игнорируется. Содержимое промта по-прежнему не логируется.

Подтверждение зависимостей: frontend P2.2 завершена — `src/api/integrationsApi.ts`
отправляет только `{ user }` (есть vitest-тест). Других потребителей `invokeConnector`
с полем `prompt` нет: внутренние роли вызывают `llmConnector.invoke` напрямую,
единственный вызов `invokeConnector` — HTTP-роут `/api/integrations/:id/invoke`.

Изменённые файлы:
- `orchestrator-service/backend/src/connectors.js` — удалён fallback `?? input.prompt`, обновлён JSDoc.
- `orchestrator-service/backend/test/connectors.test.js` — новые тесты: legacy `{ prompt }` и пустой payload → 422 `prompt_required`.
- `orchestrator-service/backend/docs/api-integrations.md` — новая документация канонического контракта invoke и удаления alias.

Ограничения: позитивный путь `{ user }` → 200 в backend-тестах не покрыт юнитом
(требует живого Postgres/провайдера); проверяется существующим frontend vitest и
E2E-валидацией оркестратора. Тесты не запускались (по контракту роли Programmer).

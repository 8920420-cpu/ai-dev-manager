---
id: ORCHESTRATOR-P2.2
status: ready
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

---
id: FRONTEND-P2.2
status: review
service: FRONTEND
priority: P2
initiative: LEGACY-CONNECTOR-PROMPT-ALIAS-001
owner: frontend
depends_on: ["tasks/orchestrator-service.md → P2.2 (удаление серверного alias)"]
---

# P2.2 LEGACY-CONNECTOR-PROMPT-ALIAS-001 — перейти с `prompt` на каноническое поле `user`

## Description

перейти с `prompt` на каноническое поле `user`

> Выполнено: `integrationsApi.invoke` отправляет `{ user }`, поле `prompt` больше не шлётся (контракт-тест `src/api/integrationsApi.test.ts`). Сервер уже принимает `user` ([connectors.js](../orchestrator-service/backend/src/connectors.js)), поэтому миграция фронтенда безопасна и является предусловием для orchestrator P2.2 (удаление серверного alias). Ранее ошибочно помечалась `[!]`.

## Scope

- Владелец исходников: `src/` (сборка в `dist/`).

## Pre-coding brief (готовит оркестратор)

- <готовит оркестратор до выдачи>

## Tasks

- Изменить `integrationsApi.invoke` и всех потребителей на payload `{ user }`; не отправлять legacy-поле `prompt`.
- Обновить типы, mocks и contract-тесты, отделив входное поле `user` от поля `prompt` в журнале обменов.

## Acceptance

- Поиск по frontend не находит отправку `{ prompt }` в `/invoke`; вызов коннектора и журнал обменов работают через канонический контракт.

## Orchestrator validation

- <определяется оркестратором>

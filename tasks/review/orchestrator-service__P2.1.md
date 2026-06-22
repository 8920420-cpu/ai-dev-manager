---
id: ORCHESTRATOR-P2.1
status: review
service: ORCHESTRATOR
priority: P2
initiative: LEGACY-BUSINESS-STORAGE-API-001
owner: orchestrator-service
depends_on: []
---

# P2.1 LEGACY-BUSINESS-STORAGE-API-001 — заменить browser storage каноническими API

## Description

Заменить browser storage каноническими API.

> Выполнено (cross-service инициатива с frontend P2.1). Миграция `0008_business_storage.sql` применена к `orchestrator_db` после явного подтверждения пользователя (projects +status/database_ref/updated_at; новые `additional_databases`, `role_connectors`). Реализованы CRUD проектов (optimistic concurrency по `updated_at`, коды конфликтов), доп. БД с redaction секрета, назначения роль→коннектор, идемпотентный импорт. Контракт: `db/BUSINESS_STORAGE_CONTRACT.md`. Тесты `node --test` (112) зелёные; read/write-пути проверены на живой БД (write — в транзакции с откатом, данные не изменены).

Подтверждённая legacy-логика: frontend хранит проекты, дополнительные БД и назначения ролей локально; backend уже имеет частичный `/api/projects`, но не предоставляет полный единый CRUD-контракт для всех трёх сущностей.

## Scope

- orchestrator-service/

## Pre-coding brief (готовит оркестратор)

- Сопоставить frontend-модели с таблицами `projects`, `services`, `project_stages`, `roles` и `connectors`; определить недостающие операции и правила владения данными.
- Любую миграцию схемы или импорт локальных данных выполнять только после отдельного явного подтверждения пользователя по правилам корневого `TASKS.md`.

## Tasks

- Завершить CRUD-контракт проектов: стабильные UUID, update/status/delete, optimistic concurrency и документированные ошибки конфликтов.
- Добавить канонические API дополнительных подключений БД и назначений «роль → коннектор» либо явно свести их к существующим серверным сущностям без дублирующего источника истины.
- Для чувствительных полей применять server-only хранение и redaction; list/read никогда не возвращают пароль или token.
- Добавить endpoint предварительной проверки и идемпотентного импорта legacy-записей с клиентским migration key; импорт не должен молча перезаписывать существующие сущности.
- После перехода всех потребителей удалить временные/частичные ветки API, которые существуют только для browser-local моделей, и обновить API-карту.

## Acceptance

- Сервер является единственным источником истины для проектов, дополнительных БД и назначений ролей; контракт достаточен для полного удаления frontend `localStore`.
- Конкурентное изменение обнаруживается, импорт повторяем и не дублирует данные, секреты отсутствуют в ответах и логах.
- Contract/integration-тесты покрывают CRUD, авторизацию, конфликт, redaction и импорт.

## Orchestrator validation

- <определяется оркестратором>

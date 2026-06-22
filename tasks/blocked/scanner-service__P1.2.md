---
id: SCANNER-P1.2
status: blocked
service: SCANNER
priority: P1
initiative: SERVICE-POST-PROGRAMMER-CONCURRENCY-001
owner: scanner-service
depends_on: ["tasks/orchestrator-service.md → P1.2 фиксирует идемпотентный completion-контракт и идентификатор блока"]
---

# P1.2 SERVICE-POST-PROGRAMMER-CONCURRENCY-001 — независимый запуск цепочек микросервисов

## Description

независимый запуск цепочек микросервисов

## Scope

- Scanner completion/state/HTTP delivery и соответствующие тесты; worker-контексты оркестратора вне scope.

## Pre-coding brief (готовит оркестратор)

- Зафиксировать DTO completion с `projectId`, `serviceId`, `blockId` и task IDs, а также idempotency key и подтверждение приёма.
- Единица состояния Scanner — конкретный блок конкретного сервиса; глобальная сериализация между сервисами запрещена.

## Tasks

- Определять завершение всего блока задач Programmer отдельно для каждого `projectId + serviceId`, не ожидая завершения задач других микросервисов проекта.
- При завершении блока отправлять в orchestrator-service один идемпотентный completion, содержащий устойчивые идентификаторы проекта, микросервиса, блока и входящих задач.
- Не удерживать глобальную блокировку на время выполнения последующих ролей: после принятия completion цепочка принадлежит отдельному worker-контексту оркестратора, а Scanner продолжает наблюдать остальные микросервисы.
- Допускать конкурентную доставку completion для микросервисов A и B; сбой или повторная доставка одного микросервиса не должны блокировать другой.
- Хранить exactly-once state раздельно по микросервисам и блоку задач; очищать task document только в границах подтверждённого блока.

## Acceptance

- Завершение задач микросервиса A запускает его цепочку независимо от незавершённых или уже выполняющихся цепочек микросервиса B.
- Одновременное завершение A и B приводит к двум отдельным completion без смешивания задач и без глобальной сериализации Scanner.
- Повторное сканирование или HTTP retry не создаёт вторую цепочку для того же блока.
- Тесты покрывают конкурентное завершение двух микросервисов, частично завершённый блок, retry и изоляцию exactly-once state.

## Orchestrator validation

- `npm test` в `scanner-service`.
- Integration P2.3 с управляемым одновременным завершением A/B, retry и частично завершённым блоком.
- Сверить task IDs и idempotency key в событиях без содержимого исходных task documents.

## Причина блокировки

Блокировка: зависимость `tasks/orchestrator-service.md` → P1.2 (идемпотентный completion-контракт с `blockId` и idempotency key) ещё `[ ]`. До фиксации DTO completion Programmer не реализует.

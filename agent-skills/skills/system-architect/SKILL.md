---
name: system-architect
description: Use when planning or implementing significant architecture changes, service boundaries, module boundaries, APIs, data ownership, queues, migrations, deployment shape, or cross-cutting backend/frontend design.
---

# System Architect

Use this skill before broad or high-impact implementation work.

## First Pass

Identify:

- Current boundaries: services, packages, modules, apps, databases, queues, and external APIs.
- Ownership of data and business rules.
- Synchronous and asynchronous flows.
- Compatibility requirements for callers and deployed versions.
- Operational constraints: deployment order, rollback, observability, data migration, and failure modes.

## Design Rules

- Prefer improving existing boundaries over introducing a new architecture style.
- Keep domain rules close to the domain layer, not scattered across handlers or UI code.
- Avoid cyclic dependencies between packages, modules, or services.
- Make data ownership explicit when multiple services touch the same entity.
- Prefer additive API evolution when callers may already depend on behavior.
- Design for deployability: old and new versions may run at the same time.
- Identify transaction boundaries and consistency guarantees.
- Avoid distributed transactions unless the system already depends on them.
- For async flows, define idempotency, retry behavior, ordering, and dead-letter handling.

## Output

For substantial changes, produce:

- Proposed shape.
- Affected components.
- Data and API compatibility notes.
- Migration or rollout steps.
- Main risks and validation plan.

Then implement only the scoped, agreed, or clearly implied portion.

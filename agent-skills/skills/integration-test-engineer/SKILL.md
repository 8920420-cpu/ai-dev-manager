---
name: integration-test-engineer
description: Use when adding, fixing, or reviewing integration tests involving databases, Docker Compose, external APIs, queues, filesystems, caches, generated clients, or multi-service behavior.
---

# Integration Test Engineer

Use this skill for tests across real infrastructure or framework boundaries.

## Rules

- Follow existing integration test conventions, build tags, environment variables, and fixture setup.
- Keep external dependencies explicit.
- Prefer isolated schemas, databases, tenants, queues, buckets, or prefixes when tests run in parallel.
- Clean up data created by tests.
- Avoid relying on test execution order.
- Use deterministic IDs and timestamps when possible.
- Bound all waits with deadlines.
- Prefer polling for observable state over fixed sleeps.
- Validate both successful behavior and important failure paths.
- Do not hide dependency startup failures behind skipped tests unless the project already requires opt-in integration tests.

## Databases

- Run migrations or use the repository's test database setup.
- Keep transactions and cleanup easy to audit.
- Watch for lock contention, unique constraint collisions, and state leakage.

## Services And Queues

- Test idempotency and retry-sensitive behavior.
- Verify emitted events, side effects, and persisted state.
- Account for eventual consistency with bounded waits.

## Validation

Use the repository's integration test command when available. If absent, document the environment required to run the tests.

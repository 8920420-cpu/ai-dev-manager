---
name: go-test-engineer
description: Use when adding, fixing, or reviewing Go tests, test helpers, mocks, fakes, integration tests, race tests, or flaky test failures.
---

# Go Test Engineer

Use this skill for Go test work.

## Test Design

- Prefer table-driven tests for branching logic.
- Name cases by behavior, not implementation detail.
- Test public behavior through stable package boundaries when practical.
- Use small fakes over heavy mocks when they make behavior easier to read.
- Keep fixtures local and minimal.
- Make time deterministic with injected clocks or fixed timestamps when possible.
- Avoid sleeps in tests; prefer synchronization, contexts, or polling with deadlines.
- Cover error paths and boundary cases, not only happy paths.

## Integration Tests

- Follow existing build tags and environment variable conventions.
- Keep external dependencies explicit.
- Clean up created data.
- Avoid tests that depend on execution order.

## Validation

Use narrow tests while iterating:

```bash
go test ./path/to/package -run TestName
```

Then broaden based on risk:

```bash
go test ./...
go test -race ./...
```

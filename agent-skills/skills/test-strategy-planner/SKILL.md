---
name: test-strategy-planner
description: Use when deciding what tests are needed for a feature, bug fix, refactor, contract change, release, or risky change across backend, frontend, database, or integration boundaries.
---

# Test Strategy Planner

Use this skill before or during changes where test scope is unclear.

## Test Levels

Choose the narrowest tests that prove the behavior, then broaden based on risk:

- Unit tests for pure logic, branching, validation, and edge cases.
- Component tests for UI behavior and interaction states.
- Integration tests for database, queue, filesystem, network, generated code, and framework boundaries.
- Contract tests for protobuf, REST, gRPC, events, and cross-service expectations.
- End-to-end tests for critical user journeys and routing.
- Smoke tests for release confidence.
- Load or performance tests for throughput, latency, or hot-path changes.

## Planning Checklist

- What behavior changed?
- What could regress?
- Which dependencies are mocked, faked, or real?
- Which failure paths matter?
- Which old and new versions must remain compatible?
- What test would fail before the fix?
- What is too expensive or flaky to test at this layer?

## Output

State the recommended tests, where they should live, and which command should run them. Keep the plan practical and tied to the repository's existing tooling.

---
name: contract-migration-planner
description: Use before making breaking or potentially breaking API, protobuf, gRPC, event, or storage contract changes. Produces a migration and rollout plan before implementation.
---

# Contract Migration Planner

Use this skill before changing public or cross-service contracts.

## First Step

Before editing, identify:

- Existing producers and consumers.
- Whether data is persisted, replayed, cached, or sent over the network.
- Compatibility requirements for old clients with new servers and new clients with old servers.
- Deployment order and rollback expectations.

## Migration Plan

For each contract change, state:

- Current shape.
- Proposed additive shape.
- Deprecation path.
- Data backfill or dual-write requirements.
- Rollout order.
- Compatibility checks.
- Removal criteria.

## Protobuf-Specific Rules

- Prefer adding a new field over changing an existing field.
- Mark old fields deprecated before removal.
- Reserve removed field numbers and names.
- Reserve removed enum numbers and names.
- Avoid changing semantics under the same field name.

## Output

When asked to implement a risky contract change, first provide the migration plan. Then implement the additive or compatible portion unless the user explicitly confirms a breaking change.

---
name: grpc-api-design
description: Use when designing, implementing, or reviewing gRPC services, RPC methods, request and response messages, status codes, deadlines, pagination, idempotency, and error details.
---

# gRPC API Design

Use this skill for gRPC service and RPC design.

## RPC Shape

- Prefer clear verb-oriented RPC names such as `GetX`, `ListX`, `CreateX`, `UpdateX`, `DeleteX`, `ArchiveX`, or domain-specific commands.
- Use dedicated request and response messages per RPC unless the repository has a strong shared-message convention.
- Keep RPC boundaries business-oriented rather than mirroring database tables too closely.
- Include `page_size` and `page_token` for list endpoints that can grow.
- Include idempotency keys for create or command RPCs that may be retried.
- Use update masks for partial updates when supported by the project.

## Errors

- Map domain failures to appropriate gRPC status codes.
- Do not return `UNKNOWN` for expected validation, auth, not-found, conflict, or precondition failures.
- Preserve useful machine-readable error details when the project uses them.
- Keep human error messages stable enough for logs, not for client logic.

## Runtime Behavior

- Respect deadlines and cancellation.
- Propagate `context.Context` through handlers and downstream calls.
- Avoid starting background work inside RPC handlers unless ownership, retry behavior, and cancellation are explicit.
- Validate requests at the boundary and keep domain invariants inside domain code.

## Compatibility

- Treat service and method names as public contracts.
- Prefer additive schema changes.
- For breaking changes, create a migration plan and versioning strategy before editing contracts.

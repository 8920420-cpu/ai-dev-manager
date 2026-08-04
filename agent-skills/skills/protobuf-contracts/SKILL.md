---
name: protobuf-contracts
description: Use when creating, editing, reviewing, or migrating .proto files, protobuf schemas, generated protobuf code, or API contract changes. Focuses on wire compatibility, field numbering, reserved fields, enum safety, and evolution strategy.
---

# Protobuf Contracts

Use this skill for protobuf schema work and generated-contract boundaries.

## Compatibility Rules

- Never reuse a field number.
- Never change the wire type of an existing field.
- Never rename or remove a field without considering generated clients, JSON names, persisted payloads, and consumers.
- When deleting a field, reserve both its number and name.
- Reserve removed enum numbers and names.
- Keep enum zero values explicit and safe, usually `*_UNSPECIFIED = 0`.
- Avoid changing package names, `go_package`, service names, RPC names, and message names without a migration plan.
- Prefer adding fields over changing existing ones.
- Treat `required` as forbidden in proto2 unless the repository already depends on it.
- Be careful with `oneof`: moving an existing field into or out of a `oneof` can break semantics.
- Be careful with `optional`: distinguish absence from default value only when callers need that distinction.
- Avoid maps when ordering, duplicate keys, or partial updates matter.

## Design Rules

- Use stable, domain-specific names instead of transport or implementation names.
- Keep request and response messages dedicated per RPC unless the repo already standardizes shared messages.
- Include pagination, filtering, sorting, idempotency keys, and update masks when the API needs them.
- Prefer additive evolution with deprecation comments over destructive changes.
- Add comments for fields whose semantics are not obvious from the name.

## Validation

If Buf is configured, prefer:

```bash
buf lint
buf breaking --against <baseline>
buf generate
```

If the repository uses plain protoc, follow its existing generation command and verify generated Go code is updated.

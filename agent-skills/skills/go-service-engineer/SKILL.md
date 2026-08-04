---
name: go-service-engineer
description: Use when implementing or modifying Go services, packages, handlers, repositories, workers, integrations, or shared Go libraries. Applies production Go engineering conventions, context handling, error handling, concurrency discipline, and local validation.
---

# Go Service Engineer

Use this skill for Go implementation work.

## Workflow

1. Inspect the existing package structure, naming, dependency direction, and tests before editing.
2. Prefer local project patterns over new abstractions.
3. Keep changes scoped to the requested behavior.
4. Run `gofmt` on changed Go files.
5. Run the narrowest relevant `go test` command first, then broaden when shared code or cross-package behavior changed.

## Go Rules

- Put `context.Context` first in function parameters when a call crosses process, storage, network, or cancellation boundaries.
- Return errors instead of logging-and-continuing unless the caller cannot act on the error.
- Wrap errors with useful operation context; preserve sentinel or typed errors with `%w` when callers may inspect them.
- Avoid package-level mutable state unless the package already uses that pattern and lifecycle is clear.
- Keep interfaces small and define them at the consumer boundary when practical.
- Do not introduce goroutines without a clear cancellation path and ownership model.
- Avoid hidden I/O in constructors; make expensive or fallible setup explicit.
- Keep database transactions explicit and ensure rollback/commit behavior is easy to audit.
- Prefer table-driven tests for branching behavior.
- Do not change public API shape casually; identify callers first.

## Validation

Use project-specific commands when present. Otherwise prefer:

```bash
gofmt -w <changed-go-files>
go test ./...
```

For concurrency-sensitive changes, also consider:

```bash
go test -race ./...
```

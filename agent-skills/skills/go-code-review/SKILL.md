---
name: go-code-review
description: Use when reviewing Go code, pull requests, diffs, or uncommitted Go changes. Prioritizes bugs, regressions, race conditions, context leaks, API breakage, and missing tests.
---

# Go Code Review

Use this skill for review tasks. Lead with findings, ordered by severity. Include file and line references when possible.

## Review Checklist

- Check for behavioral regressions and broken callers.
- Check error paths: lost errors, swallowed errors, incorrect wrapping, ambiguous messages, and missing rollback handling.
- Check nil safety around pointers, maps, slices, interfaces, and optional fields.
- Check concurrency: data races, goroutine leaks, channel deadlocks, unbounded fan-out, shared mutable state, and missing cancellation.
- Check `context.Context` propagation through storage, network, RPC, queue, and long-running calls.
- Check transaction boundaries and partial-write behavior.
- Check resource lifecycle: files, rows, response bodies, timers, tickers, locks, and subscriptions.
- Check test coverage for changed behavior, edge cases, and failure paths.
- Check compatibility of exported APIs and generated-code boundaries.

## Output Style

- Findings first.
- Include severity and exact location where possible.
- Explain the concrete failure mode, not just a style preference.
- Keep summaries secondary.
- If no issues are found, say so and mention residual test gaps or risk.

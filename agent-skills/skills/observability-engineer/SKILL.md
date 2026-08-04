---
name: observability-engineer
description: Use when adding or reviewing logs, metrics, traces, request IDs, health checks, alerts, dashboards, operational debugging, or production failure visibility.
---

# Observability Engineer

Use this skill when a change affects production diagnosability.

## Logging

- Log at service boundaries, important state transitions, retries, and failure paths.
- Include correlation IDs, request IDs, user or tenant identifiers when safe, and stable operation names.
- Do not log secrets, tokens, passwords, private keys, full credentials, or sensitive payloads.
- Avoid noisy logs inside hot loops.
- Prefer structured fields over string concatenation when the logger supports it.

## Metrics

- Track request counts, latency, error counts, retries, queue depth, processing duration, and saturation where relevant.
- Use bounded-cardinality labels.
- Avoid labels containing raw IDs, emails, names, paths with IDs, or unbounded error strings.
- Pair counters with latency or duration histograms when performance matters.

## Tracing

- Propagate context across RPC, HTTP, queue, and database boundaries.
- Add spans around meaningful external calls or expensive operations.
- Record errors on spans without leaking sensitive data.

## Health And Alerts

- Health checks should reflect dependencies required for the service to function.
- Readiness and liveness should not mean the same thing unless the platform only supports one.
- Alerts should be actionable and tied to user impact or saturation.

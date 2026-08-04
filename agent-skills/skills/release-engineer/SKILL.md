---
name: release-engineer
description: Use when preparing, reviewing, or executing releases, deployment plans, rollback plans, smoke checks, changelogs, feature flags, migrations, or production rollout coordination.
---

# Release Engineer

Use this skill for release and deployment readiness.

## Release Checklist

- Identify included changes and their user or system impact.
- Confirm required migrations, generated code, config changes, feature flags, and environment variables.
- Confirm deployment order across services, frontend, workers, and database changes.
- Define rollback steps and whether rollback is safe after migrations or data writes.
- Define smoke checks that prove the release works.
- Check observability: logs, metrics, traces, dashboards, and alerts for the changed path.
- Check compatibility with old clients, old servers, and in-flight jobs.
- Confirm background jobs, queues, cron tasks, and consumers are accounted for.

## Risk Controls

- Use feature flags or staged rollout for risky behavior changes when the project supports them.
- Keep irreversible data changes separate from application deploys when practical.
- Prefer additive contract and schema changes before switching callers.
- Avoid bundling unrelated risky changes in the same release.

## Output

For release planning, provide:

- What is being released.
- Pre-deploy steps.
- Deploy order.
- Post-deploy smoke checks.
- Monitoring window.
- Rollback or forward-fix plan.

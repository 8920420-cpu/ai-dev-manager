---
name: buf-workflow
description: Use when a repository uses Buf for protobuf linting, breaking-change checks, generation, or module management. Applies buf.yaml and buf.gen.yaml workflows for proto contract changes.
---

# Buf Workflow

Use this skill when `buf.yaml`, `buf.work.yaml`, `buf.gen.yaml`, or Buf lock files are present.

## Workflow

1. Locate Buf configuration files before editing protobufs.
2. Inspect lint and breaking-change configuration to understand the repository contract rules.
3. Keep proto package, import, and module structure consistent with existing files.
4. After proto changes, run generation using the repository's command if present.
5. Run lint and breaking checks before finishing.

## Commands

Prefer repository scripts or Make targets when available. Otherwise use:

```bash
buf lint
buf breaking --against <baseline>
buf generate
```

Choose the baseline from project conventions, CI configuration, or remote branch references. Do not invent a baseline if it cannot be inferred; report what is needed.

## Rules

- Do not edit generated files by hand.
- Keep generated output synchronized with `.proto` changes.
- Treat `buf.lock` changes as dependency updates and explain them.
- Do not weaken lint or breaking rules to make a change pass unless explicitly requested.
- If `buf breaking` fails, prefer additive schema migration over suppressing the break.

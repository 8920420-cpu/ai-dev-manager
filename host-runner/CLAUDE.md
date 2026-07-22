# host-runner — Claude Memory
> Last analyzed: 2026-07-22 (updated)
> Re-analysis needed: NO — read .claude/rules/ files instead of source files

## What this project is
Нативный исполнитель host-ролей (PIPELINE_SERVICE/GIT_INTEGRATOR): docker/git на хосте по заданиям оркестратора.

## Quick reference
- **Stack**: JavaScript
- **Dev**: `node bin/host-runner.js`
- **Test**: `node --test`
- **Build**: `N/A`

## Memory files (read these, not source files)
- @.claude/rules/architecture.md — folder map, entry points, data flow
- @.claude/rules/stack.md — tech stack, versions, all commands
- @.claude/rules/modules.md — every module and what it does
- @.claude/rules/models.md — DB schemas and data types
- @.claude/rules/api.md — all routes and endpoints
- @.claude/rules/conventions.md — naming, patterns, testing approach
- @.claude/rules/gotchas.md — quirks, workarounds, do-not-touch
- @.claude/rules/changelog.md — what changed and when

## Instruction
You have full codebase knowledge from the files above.
Do NOT re-read source files to understand structure — use memory files.
If something seems outdated, flag it rather than re-analyzing.

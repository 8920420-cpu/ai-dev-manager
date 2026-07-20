# programmer-runner — Claude Memory
> Last analyzed: 2026-07-20 (updated)
> Re-analysis needed: NO — read .claude/rules/ files instead of source files

## What this project is
Автоматический исполнитель роли PROGRAMMER (стадия CODING): опрашивает оркестратор, запускает headless Claude Code (Agent SDK) на задаче в репозитории проекта и сдаёт результат. Закрывает разрыв, из-за которого CODING двигался только живой Claude-сессией.

## Quick reference
- **Stack**: JavaScript
- **Dev**: `node bin/programmer-runner.js`
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

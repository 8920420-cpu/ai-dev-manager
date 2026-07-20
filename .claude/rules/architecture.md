# Architecture

## Folder Map
- `codex-runner/` — Project folder
- `deploy/` — Deployment configuration
- `docs/` — Documentation
- `examples/` — Project folder
- `host-runner/` — Project folder
- `logs/` — Project folder
- `marshrutka/` — Project folder
- `mcp-service/` — Project folder
- `orchestrator-service/` — Project folder
- `output/` — Project folder
- `pipeline-runner/` — Project folder
- `programmer-runner/` — Project folder
- `public/` — Static public assets
- `roles/` — Project folder
- `runtime/` — Project folder
- `scanner-service/` — Project folder
- `scripts/` — Build/deploy scripts
- `server/` — Project folder
- `shared/` — Project folder
- `src/` — Main source code
- `tasks/` — Project folder
- `tester-service/` — Project folder
- `tests/` — Test files
- `tools-service/` — Project folder
- `_orchestrator/` — Project folder
- `_orchestrator_template/` — Project folder

## Entry Points
- `src/main.tsx`

## Data Flow
1. Request hits entry point
2. Routed through middleware
3. Handled by route files in: _orchestrator_template/tasks/review, src/api, tasks/review
4. Returns response

## External Dependencies
- Docker Compose services detected (see docker-compose.yml)
- `PGHOST` — environment variable
- `PGPORT` — environment variable
- `PGUSER` — environment variable
- `PGPASSWORD` — environment variable
- `PGDATABASE` — environment variable
- `PROJECTS_HOST_ROOT` — environment variable
- `ORCHESTRATOR_API_TOKEN` — environment variable
- `RUNNER_ROLE_TIMEOUT_MS` — environment variable
- `RUNNER_CLAUDE_TIMEOUT_MS` — environment variable
- `RUNNER_HOST_TIMEOUT_MS` — environment variable

## Deployment
- Dockerfile detected
- docker-compose.yml detected

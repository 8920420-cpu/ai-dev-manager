# API Surface

## Route Files
- `_orchestrator_template/tasks/review/.gitkeep`
- `src/api/appSettingsApi.ts`
- `src/api/auditApi.ts`
- `src/api/claudeAuth.ts`
- `src/api/databaseConnectionsApi.test.ts`
- `src/api/databaseConnectionsApi.ts`
- `src/api/dbProjectsApi.ts`
- `src/api/developmentSchemeApi.ts`
- `src/api/feedbackApi.test.ts`
- `src/api/feedbackApi.ts`
- `src/api/fieldsApi.test.ts`
- `src/api/fieldsApi.ts`
- `src/api/fsAccess.ts`
- `src/api/http.ts`
- `src/api/intakeIntegrationsApi.ts`
- `src/api/integrationsApi.test.ts`
- `src/api/integrationsApi.ts`
- `src/api/mcpRolesApi.ts`
- `src/api/performanceApi.test.ts`
- `src/api/performanceApi.ts`
- `src/api/projectsApi.test.ts`
- `src/api/projectsApi.ts`
- `src/api/roleConnectionsApi.test.ts`
- `src/api/roleConnectionsApi.ts`
- `src/api/roleGroupsApi.ts`
- `src/api/rolesApi.test.ts`
- `src/api/rolesApi.ts`
- `src/api/serversApi.ts`
- `src/api/settingsApi.ts`
- `src/api/taskStatisticsApi.ts`
- `src/api/tasksApi.test.ts`
- `src/api/tasksApi.ts`
- `src/api/toolsApi.ts`
- `tasks/review/.gitkeep`
- `tasks/review/frontend__P0.1.md`
- `tasks/review/frontend__P1.1.md`
- `tasks/review/frontend__P1.2.md`
- `tasks/review/frontend__P1.3.md`
- `tasks/review/frontend__P1.4.md`
- `tasks/review/frontend__P2.1.md`
- `tasks/review/frontend__P2.2.md`
- `tasks/review/orchestrator-service__P0.1.md`
- `tasks/review/orchestrator-service__P1.1.md`
- `tasks/review/orchestrator-service__P1.3.md`
- `tasks/review/orchestrator-service__P1.4.md`
- `tasks/review/orchestrator-service__P1.5.md`
- `tasks/review/orchestrator-service__P1.6.md`
- `tasks/review/orchestrator-service__P2.1.md`
- `tasks/review/orchestrator-service__P2.2.md`
- `tasks/review/pipeline-runner__P1.1.md`
- `tasks/review/pipeline-runner__P1.2.md`
- `tasks/review/scanner-service__P1.1.md`

## Base URL
- Check entry point configuration

## Auth
- Check middleware files for auth implementation

## Endpoints
- Read route files above for detailed endpoint listing

## WebSockets / Events
- Not auto-detected — fill in if applicable

## Codebase Memory
- `GET /api/projects/:id/codebase-memory` lists memory document metadata. Add `?includeContent=1` to include markdown content.
- `GET /api/projects/:id/codebase-memory/:key` reads one memory document.
- `PUT /api/projects/:id/codebase-memory/:key` upserts one memory document.
- `POST /api/projects/:id/codebase-memory` bulk syncs memory documents.

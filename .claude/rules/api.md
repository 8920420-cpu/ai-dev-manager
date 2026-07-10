# API Surface

## Route Files
No route files detected

## Base URL
- Check entry point configuration

## Auth
- Check middleware files for auth implementation

## Endpoints
- Read route files above for detailed endpoint listing

## Codebase Memory
- `GET /api/projects/:id/codebase-memory` lists memory document metadata. Add `?includeContent=1` to include markdown content.
- `GET /api/projects/:id/codebase-memory/:key` reads one memory document.
- `PUT /api/projects/:id/codebase-memory/:key` upserts one memory document.
- `POST /api/projects/:id/codebase-memory` bulk syncs memory documents.

## WebSockets / Events
- Not auto-detected — fill in if applicable

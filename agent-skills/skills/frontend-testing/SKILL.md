---
name: frontend-testing
description: Use when adding, fixing, or reviewing frontend tests for React, Next.js, TypeScript, forms, hooks, components, Playwright end-to-end tests, or Testing Library tests.
---

# Frontend Testing

Use this skill for frontend test work.

## Test Strategy

- Test behavior visible to users rather than component internals.
- Prefer Testing Library queries by role, label, text, and accessible name.
- Avoid brittle selectors unless testing implementation-specific integration points.
- Cover loading, error, empty, success, validation, and permission states when touched by the change.
- Mock network boundaries deliberately; keep mocks close to the behavior being tested.
- Avoid arbitrary sleeps in tests; wait for observable UI or state changes.
- Keep fixtures small and meaningful.
- Use Playwright for cross-page flows, routing, auth, and browser-specific behavior.

## React And Next.js

- Account for server/client boundaries in Next.js tests.
- Test server-rendered and client-interactive behavior at the right level.
- For forms, test keyboard and submit behavior, not only click paths.
- For async UI, assert both pending and settled states when meaningful.

## Validation

Prefer project scripts. Common checks:

```bash
npm test
npm run test
npm run test:e2e
npm run lint
npm run build
```

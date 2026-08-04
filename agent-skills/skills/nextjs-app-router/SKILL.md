---
name: nextjs-app-router
description: Use when working on Next.js App Router projects, including app directory routes, layouts, server components, client components, route handlers, metadata, loading and error states, caching, and server actions.
---

# Next.js App Router

Use this skill for Next.js projects using the `app/` directory.

## App Router Rules

- Default to Server Components. Add `"use client"` only when component state, effects, browser APIs, or client event handlers are required.
- Keep client components as small as practical and pass serializable props across the server/client boundary.
- Put shared route UI in `layout.tsx` and route-specific UI in `page.tsx`.
- Use `loading.tsx`, `error.tsx`, and `not-found.tsx` when the route needs explicit user-facing states.
- Use route handlers for HTTP endpoints under `app/api` or route segments when the project follows that pattern.
- Keep metadata in `metadata` exports or `generateMetadata` as appropriate.
- Avoid importing server-only modules into client components.
- Avoid leaking secrets into client bundles.

## Data And Caching

- Understand whether a route should be static, dynamic, revalidated, or fully uncached before changing fetch behavior.
- Be explicit about cache semantics for server `fetch` calls when correctness depends on freshness.
- Use `revalidatePath`, `revalidateTag`, or router refresh patterns according to existing project conventions.
- Treat server actions as public mutation endpoints: validate input and enforce auth.

## Validation

Prefer project scripts. Common checks:

```bash
npm run lint
npm run typecheck
npm run build
```

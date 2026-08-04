---
name: nextjs-performance
description: Use when optimizing or reviewing Next.js performance, rendering strategy, caching, images, bundle size, Core Web Vitals, streaming, route loading, and server/client component boundaries.
---

# Next.js Performance

Use this skill for Next.js performance work.

## Rendering Strategy

- Identify whether each route should be static, dynamic, ISR, streamed, or fully uncached.
- Avoid forcing dynamic rendering accidentally with cookies, headers, search params, or uncached fetches unless required.
- Keep expensive work on the server when possible.
- Minimize client component surface area.
- Avoid importing heavy server or utility modules into client bundles.

## Data And Cache

- Use explicit cache and revalidation semantics where correctness or performance depends on them.
- Avoid duplicate fetching across layouts, pages, and components when the framework or project has a shared pattern.
- Use tags or path revalidation consistently after mutations.
- Keep loading states useful during streaming and route transitions.

## Assets And Bundle

- Use `next/image` or the project's image optimization approach for meaningful images.
- Avoid shipping large icons, date libraries, editors, charts, or SDKs to the client unless needed.
- Prefer dynamic imports for heavy client-only UI when it is not needed for first interaction.

## Validation

Use project tooling when available:

```bash
npm run build
npm run lint
```

Inspect bundle output or Web Vitals when the project provides those checks.

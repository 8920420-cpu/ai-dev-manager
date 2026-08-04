---
name: frontend-code-review
description: Use when reviewing React, Next.js, TypeScript frontend code, UI diffs, hooks, forms, routing, state management, accessibility, performance, and browser behavior.
---

# Frontend Code Review

Use this skill for frontend review tasks. Lead with findings, ordered by severity. Include file and line references when possible.

## Review Checklist

- Check for broken user flows, missing loading states, missing error states, and broken empty states.
- Check hydration risks in Next.js: non-deterministic render output, browser-only APIs on the server, and server/client boundary mistakes.
- Check hook correctness: stale closures, missing dependencies, excessive effects, and cleanup.
- Check form behavior: validation, disabled/submitting states, double-submit protection, reset behavior, and accessible labels.
- Check accessibility: semantic HTML, keyboard support, focus management, color contrast, labels, and ARIA misuse.
- Check performance: unnecessary rerenders, large client bundles, expensive render loops, unoptimized images, and avoidable client components.
- Check security: XSS, unsafe HTML, leaked secrets, auth bypass, CSRF-sensitive mutations, and unsafe redirects.
- Check API interaction: race conditions, cancellation, retry behavior, cache invalidation, and optimistic updates.
- Check test coverage for changed behavior and edge cases.

## Output Style

- Findings first.
- Explain the concrete user-visible or production failure mode.
- Keep style-only comments out unless they hide a real defect.
- If no issues are found, say so and mention residual test gaps or risk.

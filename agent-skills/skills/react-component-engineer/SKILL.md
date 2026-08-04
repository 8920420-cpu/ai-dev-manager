---
name: react-component-engineer
description: Use when creating or modifying React components, hooks, props, forms, local state, effects, composition patterns, or component-level behavior.
---

# React Component Engineer

Use this skill for React component implementation.

## Workflow

1. Inspect existing component structure, styling approach, and state patterns before editing.
2. Prefer composition and local patterns already used in the project.
3. Keep components focused: separate view composition from data fetching and side effects when the codebase supports it.
4. Validate with the project's typecheck, lint, test, or build commands.

## React Rules

- Keep render logic pure.
- Do not put derived state in `useState` unless it must be user-editable or preserved independently.
- Use `useEffect` for synchronization with external systems, not for ordinary data derivation.
- Keep hook dependency arrays correct; do not suppress hook lint rules without a concrete reason.
- Avoid stale closures in callbacks, async effects, event handlers, and timers.
- Clean up subscriptions, timers, observers, and in-flight async work when relevant.
- Prefer controlled inputs for forms unless the project intentionally uses uncontrolled patterns.
- Keep prop names clear and stable.
- Avoid unnecessary context; use it for cross-tree concerns, not routine prop passing.
- Preserve accessibility: semantic elements, labels, focus behavior, keyboard support, and ARIA only when needed.

## Validation

Prefer project scripts. Common checks:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

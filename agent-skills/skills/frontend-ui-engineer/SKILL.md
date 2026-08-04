---
name: frontend-ui-engineer
description: Use when building or modifying frontend UI, responsive layouts, CSS, Tailwind, design-system components, forms, tables, dialogs, navigation, dashboards, or visual interaction states.
---

# Frontend UI Engineer

Use this skill for user-facing UI implementation.

## UI Rules

- Follow the project's existing design system, spacing scale, typography, color tokens, and component library.
- Build the actual workflow as the first screen for apps and tools, not a marketing-style landing page unless requested.
- Use semantic HTML and accessible controls.
- Ensure keyboard navigation and focus states work for interactive UI.
- Include loading, disabled, active, hover, focus, error, empty, and success states when relevant.
- Keep text within containers across mobile and desktop.
- Use responsive layout constraints so UI does not shift or overlap when content changes.
- Avoid nested cards and decorative clutter unless the existing design system relies on it.
- Prefer icons from the project's icon library for common actions.
- Do not add a new styling system unless the project already uses it or the user requests it.

## Common Components

- Forms need labels, validation messages, submitting states, and double-submit protection.
- Tables need empty states, overflow behavior, loading states, and readable density.
- Dialogs need focus management, close behavior, and accessible names.
- Navigation needs clear active state and mobile behavior.

## Validation

When feasible, check the UI in at least one desktop and one mobile viewport. Run project lint/build checks before finishing.

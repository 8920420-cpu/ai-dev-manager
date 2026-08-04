---
name: react-state-management
description: Use when designing, modifying, or reviewing React state management, including local state, context, reducers, Zustand, Redux, TanStack Query, SWR, server state, optimistic updates, and cache invalidation.
---

# React State Management

Use this skill for frontend state design.

## State Placement

- Keep state as local as practical.
- Use URL state for shareable filters, pagination, tabs, and navigation state when appropriate.
- Use server state libraries for remote data, caching, refetching, and invalidation.
- Use context for cross-tree dependencies, not as a default global store.
- Use reducers when transitions are complex enough to benefit from explicit events.

## Server State

- Distinguish server state from client UI state.
- Define cache keys consistently.
- Invalidate or update cached data after mutations.
- Handle optimistic updates with rollback behavior.
- Avoid duplicate sources of truth between local state and server cache.

## Reliability

- Prevent race conditions in overlapping requests.
- Keep loading, stale, error, and empty states explicit.
- Avoid storing derived values that can be computed safely during render.
- Avoid global state for transient component concerns.

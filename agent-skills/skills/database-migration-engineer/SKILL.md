---
name: database-migration-engineer
description: Use when creating, reviewing, or planning database schema migrations, indexes, constraints, data backfills, rollback plans, zero-downtime deployments, or PostgreSQL/MySQL migration safety.
---

# Database Migration Engineer

Use this skill for database schema and data migration work.

## Migration Safety

- Design migrations to be compatible with old and new application versions during rollout.
- Prefer expand-and-contract for breaking schema changes.
- Add nullable columns or defaults carefully; understand table rewrite and lock behavior.
- Backfill large tables in batches.
- Add indexes concurrently when the database supports it and production size requires it.
- Avoid long-running transactions on large tables.
- Keep rollback behavior explicit.
- Do not drop columns, tables, enum values, or constraints until all deployed code no longer depends on them.

## PostgreSQL Notes

- Consider `CREATE INDEX CONCURRENTLY` for large production tables.
- Be careful with `ALTER TABLE ... ADD COLUMN ... DEFAULT` on older PostgreSQL versions.
- Validate constraints in phases when needed: add as not valid, backfill, then validate.
- Watch for enum changes, lock levels, and migration transaction settings.

## Review Checklist

- Does old code work with the new schema?
- Does new code work before and after the migration?
- Is the migration safe on realistic data volume?
- Are indexes aligned with query predicates and ordering?
- Is there a backfill, verification, and cleanup plan?
- Is rollback possible or intentionally forward-only?

## Validation

Run repository migration checks and relevant integration tests when available.

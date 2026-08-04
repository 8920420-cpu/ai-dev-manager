---
name: security-reviewer
description: Use when reviewing or changing authentication, authorization, permissions, secrets, input validation, file handling, redirects, web security, dependencies, API exposure, or sensitive data flows.
---

# Security Reviewer

Use this skill for security-sensitive changes and reviews.

## Checklist

- Authentication: verify identity is established by trusted middleware or explicit checks.
- Authorization: check permissions on every object or tenant boundary, not just route access.
- Input validation: validate shape, size, type, range, and business constraints at boundaries.
- Secrets: never log, expose, commit, or send secrets to the client.
- Injection: check SQL, shell, template, LDAP, path, and command construction.
- Web security: check XSS, CSRF, unsafe redirects, clickjacking-sensitive flows, and cookie flags.
- SSRF: validate or restrict outbound URLs and metadata-service access.
- File handling: validate paths, extensions, content type, size, and storage location.
- Dependency risk: avoid adding packages for trivial needs; check maintenance and transitive impact.
- Error handling: do not expose stack traces, internal IDs, or sensitive operational details to users.

## Frontend

- Treat client-side checks as UX only; enforce security server-side.
- Avoid rendering untrusted HTML.
- Keep tokens out of local storage unless the project explicitly accepts that risk.

## Backend

- Use parameterized queries and safe APIs.
- Enforce tenant isolation close to data access.
- Ensure background jobs and internal endpoints also enforce authorization or trusted caller boundaries.

## Output

Prioritize exploitable issues and concrete failure modes. Include recommended fixes.

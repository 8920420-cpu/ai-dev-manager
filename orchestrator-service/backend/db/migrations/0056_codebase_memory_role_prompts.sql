-- CODEBASE-MEMORY-MCP-ROLE-PROMPTS-001
-- Make executable roles use the PostgreSQL-backed Codebase Memory exposed
-- through the orchestrator MCP tools before they inspect repository files.

BEGIN;

CREATE TEMP TABLE _codebase_memory_prompt_patch (
  marker text PRIMARY KEY,
  patch text NOT NULL
) ON COMMIT DROP;

INSERT INTO _codebase_memory_prompt_patch (marker, patch) VALUES
(
  'CODEBASE-MEMORY-MCP-ROLE-PROMPTS-001',
  $patch$

## Codebase Memory
<!-- CODEBASE-MEMORY-MCP-ROLE-PROMPTS-001 -->
- Before role-specific work for a project, read the saved Codebase Memory through MCP:
  `orchestrator_list_codebase_memory` for the project, then the relevant
  `orchestrator_get_codebase_memory` documents.
- Prefer these documents for first orientation: `architecture`, `stack`, `modules`,
  `models`, `api`, `conventions`, `gotchas`, and `changelog`.
- If Codebase Memory is missing or stale, state that explicitly, then inspect the
  repository source files directly and continue with evidence.
- Do not invent project structure, services, APIs, database schema, commands, or
  conventions when Codebase Memory and source evidence are absent.
$patch$
);

CREATE TEMP TABLE _codebase_memory_prompt_targets ON COMMIT DROP AS
SELECT r.id,
       r.code,
       r.prompt AS old_prompt,
       r.prompt || p.patch AS new_prompt
  FROM roles r
 CROSS JOIN _codebase_memory_prompt_patch p
 WHERE COALESCE(r.prompt, '') <> ''
   AND r.prompt NOT LIKE '%' || p.marker || '%';

UPDATE roles r
   SET prompt = t.new_prompt
  FROM _codebase_memory_prompt_targets t
 WHERE r.id = t.id;

UPDATE prompts old
   SET is_active = false
  FROM _codebase_memory_prompt_targets t
 WHERE old.role_id = t.id
   AND old.is_active = true;

INSERT INTO prompts (role_id, version, prompt_text, is_active, content_hash, label, author)
SELECT t.id,
       COALESCE((SELECT max(version) FROM prompts WHERE role_id = t.id), 0) + 1,
       t.new_prompt,
       true,
       encode(digest(t.new_prompt, 'sha256'), 'hex'),
       'codebase-memory-mcp',
       'migration:0056'
  FROM _codebase_memory_prompt_targets t;

COMMIT;

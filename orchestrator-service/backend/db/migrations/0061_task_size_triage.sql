-- =====================================================================
-- TASK-SIZE-TRIAGE-001 -- task_size in the Task Intake Officer contract.
--
-- The Intake Officer already classifies category/type/priority. It now also
-- estimates the task SIZE (small|medium|large) so the pipeline can triage the
-- route deterministically without a separate router role:
--   * small  -- a narrow change (~1 file/service, cosmetics/docs or a local
--               bugfix); the Programmer delivery SKIPS the Task Reviewer stage
--               (acceptScannerCompletionTx) and the Architect does NOT split it
--               into per-service tasks;
--   * medium -- a normal feature/bugfix in one service (default, unchanged flow);
--   * large  -- spans two or more services / needs decomposition (the existing
--               Architect per-service split already covers this path).
-- Absent or unrecognized value is treated as medium by the server.
--
-- Mirrors INTAKE-OFFICER-PRIORITY-001 (migration 0048): (1) fields dictionary key;
-- (2) role output contract (role_fields, direction=out, optional); (3) pipeline
-- prompt append guarded by a marker so a repeated run does not duplicate text.
-- =====================================================================
BEGIN;

-- 1. Fields dictionary: key task_size.
INSERT INTO fields (key, name, description, value_type) VALUES
  ('task_size', 'Task size',
   'Triage size for routing: small = a narrow change (about one file or one service, cosmetics, docs, or a local bugfix) that does not need a separate review; medium = a normal feature or bugfix contained in one service (default); large = spans two or more services or needs decomposition/research before coding. Absent or unrecognized is treated as medium by the server.', 'text')
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  value_type = EXCLUDED.value_type;

-- 2. Role output contract: task_size -- optional field (server defaults to medium).
INSERT INTO role_fields (role_id, field_id, direction, required, position)
SELECT r.id, f.id, 'out', false, 15
  FROM fields f
  JOIN roles r ON r.code = 'TASK_INTAKE_OFFICER'
 WHERE f.key = 'task_size'
ON CONFLICT (role_id, field_id, direction) DO UPDATE SET
  required = EXCLUDED.required,
  position = EXCLUDED.position;

-- 3. Pipeline prompt -- append once (idempotent, guard marker).
UPDATE roles SET prompt = prompt || $intake$

<!-- TASK-SIZE-TRIAGE-001 -->

## Task size
Add a `task_size` key to the task card: one of `small`, `medium`, `large` (default `medium`). Estimate the amount of work:
- `small` -- a narrow change: about one file or one service, cosmetics, docs, or a local bugfix. Such a task does not need a separate review step.
- `medium` -- a normal feature or bugfix contained in a single service (the default when unsure).
- `large` -- the change spans two or more services, or needs decomposition/research before coding.

Base the estimate only on the request and provided context; when unsure, use `medium`. Do not choose `large` just to be safe -- reserve it for genuinely multi-service or decomposition-heavy work.
$intake$
 WHERE code = 'TASK_INTAKE_OFFICER'
   AND prompt IS NOT NULL
   AND prompt NOT LIKE '%TASK-SIZE-TRIAGE-001%';

COMMIT;

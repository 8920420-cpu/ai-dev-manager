import test from 'node:test';
import assert from 'node:assert/strict';
import { closeBlockedDuplicateTasks, findDuplicateTaskTx, reattachBlockedOwnerRoles } from '../src/db.js';

function fakeClient(rules = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const rule of rules) {
        if (rule.re.test(sql)) return rule.reply ?? { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('findDuplicateTaskTx narrows project duplicates by serviceId when provided', async () => {
  const c = fakeClient([
    { re: /service_id IS NOT DISTINCT FROM \$3/, reply: { rowCount: 1, rows: [{ id: 'dup-1', title: 'Duplicate' }] } },
  ]);

  const hit = await findDuplicateTaskTx(c, { projectId: 'project-1', serviceId: 'service-1', fingerprint: 'fp-1' });

  assert.equal(hit.id, 'dup-1');
  assert.deepEqual(c.calls[0].params, ['project-1', 'fp-1', 'service-1']);
  assert.match(c.calls[0].sql, /service_id IS NOT DISTINCT FROM \$3/);
});

test('reattachBlockedOwnerRoles restores role for blocked orphan tasks without changing status', async () => {
  const c = fakeClient([
    { re: /blocked_owner_role_reattached/, reply: { rowCount: 2, rows: [] } },
  ]);

  const fixed = await reattachBlockedOwnerRoles(c);

  assert.equal(fixed, 2);
  assert.match(c.calls[0].sql, /t\.status = 'BLOCKED'/);
  assert.match(c.calls[0].sql, /SELECT te\.role_id FROM task_events/);
  assert.match(c.calls[0].sql, /SELECT ar\.role_id FROM agent_runs/);
  assert.match(c.calls[0].sql, /status::task_status, status::task_status/);
});

test('closeBlockedDuplicateTasks cancels only blocked duplicates in project-service-fingerprint scope', async () => {
  const c = fakeClient([
    { re: /blocked_duplicate_cleanup/, reply: { rowCount: 7, rows: [] } },
  ]);

  const closed = await closeBlockedDuplicateTasks(c);

  assert.equal(closed, 7);
  assert.match(c.calls[0].sql, /PARTITION BY t\.project_id, t\.service_id, t\.data_card->>'messageFingerprint'/);
  assert.match(c.calls[0].sql, /status = 'BLOCKED'/);
  assert.match(c.calls[0].sql, /assigned_agent_id IS NOT NULL/);
  assert.match(c.calls[0].sql, /'duplicateOf'/);
  assert.match(c.calls[0].sql, /'duplicate_closed'/);
});

// FORK-JOIN-DEDUP-ANCESTRY-001 — заблокированный fork-ребёнок не должен закрываться
// как дубликат собственного join-родителя/предка. Дедуп обходит цепочку предков
// (parent_task_id) и исключает кандидата, чей original_id — его предок, чтобы
// возвратимый сбой ветки не превращался в необратимый join_child_failed.
test('closeBlockedDuplicateTasks excludes fork children whose duplicateOf would be their own ancestor', async () => {
  const c = fakeClient([
    { re: /blocked_duplicate_cleanup/, reply: { rowCount: 0, rows: [] } },
  ]);

  await closeBlockedDuplicateTasks(c);
  const sql = c.calls[0].sql;

  // Обход цепочки предков — рекурсивный CTE по parent_task_id (как в resolveHostTaskContext).
  assert.match(sql, /WITH RECURSIVE/);
  assert.match(sql, /ancestors AS \(/);
  assert.match(sql, /parent_task_id AS ancestor_id/);
  assert.match(sql, /FROM ancestors a\s+JOIN tasks p ON p\.id = a\.ancestor_id/);
  // victims исключает кандидата, чей original_id найден среди его предков.
  assert.match(sql, /NOT EXISTS \([\s\S]*SELECT 1 FROM ancestors a[\s\S]*a\.candidate_id = c1\.id AND a\.ancestor_id = c1\.original_id/);
});

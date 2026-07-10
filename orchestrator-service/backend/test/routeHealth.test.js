import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRouteHealthReport } from '../src/routeHealth.js';

// Утилита: собрать этап-контракт с дефолтами (см. stages.js → stageContract).
function stage(overrides = {}) {
  return {
    id: overrides.id ?? '00000000-0000-0000-0000-000000000000',
    kind: overrides.kind ?? 'stage',
    stageKey: overrides.stageKey ?? null,
    joinKey: overrides.joinKey ?? null,
    name: overrides.name ?? 'Этап',
    enabled: overrides.enabled ?? true,
    position: overrides.position ?? 0,
    taskStatus: overrides.taskStatus ?? 'CODING',
    roleIds: overrides.roleIds ?? [],
    roleCodes: overrides.roleCodes ?? [],
  };
}

test('(а) роль-без-исполнителя в enabled kind=stage → problem role_without_executor', () => {
  const report = buildRouteHealthReport(
    [stage({ id: 's1', name: 'Мутный этап', roleCodes: ['NO_SUCH_ROLE'], taskStatus: 'CODING' })],
    {},
  );
  const p = report.problems.find((x) => x.code === 'role_without_executor');
  assert.ok(p, 'ожидался problem role_without_executor');
  assert.equal(p.severity, 'error');
  assert.equal(p.roleCode, 'NO_SUCH_ROLE');
  assert.equal(p.stageId, 's1');
  assert.ok(report.summary.error >= 1);
  assert.equal(report.summary.ok, false);
});

test('(б) fork/join-нода с пустым taskStatus НЕ помечается stage_missing_status/role_without_executor', () => {
  const report = buildRouteHealthReport(
    [
      stage({ id: 'f1', kind: 'fork', name: 'FORK', stageKey: 'fork-key', joinKey: 'join-key', taskStatus: '', roleCodes: ['FORK_GATE'] }),
      stage({ id: 'j1', kind: 'join', name: 'JOIN', stageKey: 'join-key', joinKey: null, taskStatus: '', roleCodes: ['JOIN_GATE'] }),
    ],
    {},
  );
  assert.ok(!report.problems.some((p) => p.code === 'stage_missing_status'), 'fork/join не должны давать stage_missing_status');
  assert.ok(!report.problems.some((p) => p.code === 'role_without_executor'), 'fork/join не должны давать role_without_executor');
  // Парная fork↔join связка не должна давать fork_join_unpaired.
  assert.ok(!report.problems.some((p) => p.code === 'fork_join_unpaired'), 'парные fork↔join не должны помечаться непарными');
});

test('(в) host-роль с LLM-коннектором → problem host_role_llm_connector', () => {
  const report = buildRouteHealthReport(
    [stage({ id: 's2', name: 'Интеграция', roleCodes: ['GIT_INTEGRATOR'], taskStatus: 'COMMIT' })],
    { GIT_INTEGRATOR: { provider: 'codex', isEnabled: true } },
  );
  const p = report.problems.find((x) => x.code === 'host_role_llm_connector');
  assert.ok(p, 'ожидался problem host_role_llm_connector');
  assert.equal(p.severity, 'error');
  assert.equal(p.roleCode, 'GIT_INTEGRATOR');
});

test('(г) reasoning-роль без включённого коннектора → problem reasoning_role_no_connector', () => {
  // Нет записи о коннекторе вовсе.
  const noConn = buildRouteHealthReport(
    [stage({ id: 's3', name: 'Ревью', roleCodes: ['TASK_REVIEWER'], taskStatus: 'REVIEW' })],
    {},
  );
  const p1 = noConn.problems.find((x) => x.code === 'reasoning_role_no_connector');
  assert.ok(p1, 'ожидался problem reasoning_role_no_connector при отсутствии коннектора');
  assert.equal(p1.severity, 'warning');
  assert.equal(p1.roleCode, 'TASK_REVIEWER');

  // Коннектор есть, но выключен.
  const disabled = buildRouteHealthReport(
    [stage({ id: 's3', name: 'Ревью', roleCodes: ['TASK_REVIEWER'], taskStatus: 'REVIEW' })],
    { TASK_REVIEWER: { provider: 'deepseek', isEnabled: false } },
  );
  assert.ok(
    disabled.problems.some((x) => x.code === 'reasoning_role_no_connector'),
    'выключенный коннектор считается отсутствием исполнителя',
  );

  // Коннектор включён — проблемы нет.
  const ok = buildRouteHealthReport(
    [stage({ id: 's3', name: 'Ревью', roleCodes: ['TASK_REVIEWER'], taskStatus: 'REVIEW' })],
    { TASK_REVIEWER: { provider: 'deepseek', isEnabled: true } },
  );
  assert.ok(
    !ok.problems.some((x) => x.code === 'reasoning_role_no_connector'),
    'включённый коннектор снимает проблему',
  );
});

test('чистый маршрут (host-роль без LLM-коннектора, reasoning с включённым коннектором) → summary.ok=true', () => {
  const report = buildRouteHealthReport(
    [
      stage({ id: 's4', name: 'Ревью', roleCodes: ['TASK_REVIEWER'], taskStatus: 'REVIEW' }),
      stage({ id: 's5', name: 'Интеграция', roleCodes: ['GIT_INTEGRATOR'], taskStatus: 'COMMIT' }),
    ],
    { TASK_REVIEWER: { provider: 'deepseek', isEnabled: true } },
  );
  assert.equal(report.problems.length, 0);
  assert.equal(report.summary.ok, true);
  assert.equal(report.summary.total, 0);
});

test('непарный fork → problem fork_join_unpaired (warning)', () => {
  const report = buildRouteHealthReport(
    [stage({ id: 'f2', kind: 'fork', name: 'Одинокий fork', stageKey: 'fork-x', joinKey: 'missing-join', taskStatus: '' })],
    {},
  );
  const p = report.problems.find((x) => x.code === 'fork_join_unpaired');
  assert.ok(p, 'ожидался problem fork_join_unpaired');
  assert.equal(p.severity, 'warning');
});

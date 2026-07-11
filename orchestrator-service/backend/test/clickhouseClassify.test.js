import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from '../src/clickhouseObservability.js';

const { classify } = __test__;

// Хелпер: собрать row как его видит classify (run_status + текстовые сигналы).
function row({ status = 'FAILED', error_text = null, outcome = null, outStatus = null }) {
  return { run_status: status, error_text, outcome, output_json: outStatus ? { status: outStatus } : null };
}

test('успех без проблемного вердикта → ok/none', () => {
  const c = classify(row({ status: 'SUCCESS', outcome: 'success' }), 'programmer_completed');
  assert.equal(c.severity, 'ok');
  assert.equal(c.error_component, 'none');
  assert.equal(c.error_class, null);
});

test('успех с вердиктом BLOCKED (docs-роль) → warning/role_logic', () => {
  const c = classify(row({ status: 'SUCCESS', outStatus: 'BLOCKED' }), 'BLOCKED');
  assert.equal(c.severity, 'warning');
  assert.equal(c.error_component, 'role_logic');
  assert.equal(c.error_class, 'verdict_blocked');
});

test('лимит подписки провайдера → provider/warning', () => {
  const c = classify(row({ status: 'FAILED', outcome: "agent_threw: Claude Code returned an error result: You've hit your session limit · resets 6:50am" }), null);
  assert.equal(c.error_component, 'provider');
  assert.equal(c.error_class, 'provider_usage_limit');
});

test('403 Request not allowed → provider_auth/fatal', () => {
  const c = classify(row({ status: 'FAILED', outcome: 'agent_threw: Failed to authenticate. API Error: 403 Request not allowed' }), null);
  assert.equal(c.error_class, 'provider_auth');
  assert.equal(c.severity, 'fatal');
});

test('API Error: Overloaded → provider_overloaded/warning', () => {
  const c = classify(row({ status: 'FAILED', outcome: 'agent_threw: Claude Code returned an error result: API Error: Overloaded' }), null);
  assert.equal(c.error_class, 'provider_overloaded');
});

test('провал стадии unit-tests → pipeline_test_failed', () => {
  const c = classify(row({ status: 'FAILED', error_text: 'pipeline_stage_failed: Стадия "unit-tests" провалилась, команда: npm --prefix host-runner test, exit=1' }), null);
  assert.equal(c.error_component, 'pipeline');
  assert.equal(c.error_class, 'pipeline_test_failed');
});

test('cherry-pick failed → git/cherry_pick_failed', () => {
  const c = classify(row({ status: 'FAILED', error_text: 'git_integrator_failed: cherry-pick failed: error: could not apply c81665b' }), null);
  assert.equal(c.error_component, 'git');
  assert.equal(c.error_class, 'cherry_pick_failed');
});

test('integrate_conflict → git/warning (шум)', () => {
  const c = classify(row({ status: 'FAILED', error_text: 'integrate_conflict: содержимое в основном дереве расходится с патчем ветки' }), null);
  assert.equal(c.error_component, 'git');
  assert.equal(c.error_class, 'integrate_conflict');
  assert.equal(c.severity, 'warning');
});

test('worktree_ensure_failed (гонка) → git/warning', () => {
  const c = classify(row({ status: 'FAILED', outcome: 'worktree_ensure_failed: Command failed: git worktree add ... index.lock' }), null);
  assert.equal(c.error_class, 'worktree_ensure_failed');
  assert.equal(c.severity, 'warning');
});

test('missing_required_inputs → contract/error', () => {
  const c = classify(row({ status: 'FAILED', error_text: 'missing_required_inputs: affected_files' }), null);
  assert.equal(c.error_component, 'contract');
  assert.equal(c.error_class, 'missing_required_inputs');
});

test('repository_path не задан → config/error', () => {
  const c = classify(row({ status: 'FAILED', error_text: 'сервис orchestrator-service: repository_path не задан/не найден' }), null);
  assert.equal(c.error_class, 'repository_path_missing');
  assert.equal(c.error_component, 'config');
});

test('реальный role_timeout → runner/error', () => {
  const c = classify(row({ status: 'TIMEOUT', error_text: 'role execution timed out before producing a structured result' }), 'role_timeout');
  assert.equal(c.error_component, 'runner');
  assert.equal(c.error_class, 'role_timeout');
  assert.equal(c.severity, 'error');
});

test('reap из-за рестарта оркестратора отделён от role_timeout → warning', () => {
  const c = classify(row({ status: 'TIMEOUT', error_text: 'orchestrator restarted while run was RUNNING; run was reaped as TIMEOUT' }), 'orchestrator_restart_reconcile');
  assert.equal(c.error_class, 'orchestrator_restart_reap');
  assert.equal(c.severity, 'warning');
});

test('verdict_unparsed → role_logic/error', () => {
  const c = classify(row({ status: 'FAILED' }), 'verdict_unparsed');
  assert.equal(c.error_class, 'verdict_unparsed');
});

test('benign release НЕ считается сбоем → lifecycle/info', () => {
  const c = classify(row({ status: 'CANCELLED', error_text: 'programmer_released: released', outcome: 'released' }), 'released');
  assert.equal(c.error_component, 'lifecycle');
  assert.equal(c.severity, 'info');
});

test('причина сбоя важнее lifecycle: released из-за worktree → git', () => {
  const c = classify(row({ status: 'CANCELLED', error_text: 'programmer_released: worktree_ensure_failed: Command failed: git worktree add ... index.lock', outcome: 'released' }), null);
  assert.equal(c.error_component, 'git');
  assert.equal(c.error_class, 'worktree_ensure_failed');
});

test('голый CANCELLED без сигналов → lifecycle/info', () => {
  const c = classify(row({ status: 'CANCELLED' }), null);
  assert.equal(c.error_class, 'cancelled');
  assert.equal(c.severity, 'info');
});

test('FAILED без распознанных сигналов → unknown/error', () => {
  const c = classify(row({ status: 'FAILED' }), null);
  assert.equal(c.error_component, 'unknown');
  assert.equal(c.severity, 'error');
});

test('max turns exceeded → runner/error', () => {
  const c = classify(row({ status: 'FAILED', outcome: 'agent_threw: Reached maximum number of turns (100)' }), null);
  assert.equal(c.error_class, 'max_turns_exceeded');
});

test('infrastructure_blocked → infra', () => {
  const c = classify(row({ status: 'FAILED', outStatus: 'INFRASTRUCTURE_BLOCKED' }), 'infrastructure_blocked');
  assert.equal(c.error_component, 'infra');
  assert.equal(c.error_class, 'infrastructure_blocked');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROGRAMMER_COMPLETION_INSTRUCTION,
  buildProgrammerClaimTask,
  buildProgrammerRunSnapshot,
  programmerModelForKind,
} from '../src/programmerClaim.js';

test('buildProgrammerRunSnapshot prefers enabled connector model over routing and agent default', () => {
  const { model, snapshot } = buildProgrammerRunSnapshot({
    connectorRow: { connector_id: 'conn-1', provider: 'anthropic', model: 'claude-opus-custom' },
    agentRow: { model: 'agent-default' },
    taskKind: 'subtask',
  });

  assert.equal(model, 'claude-opus-custom');
  assert.deepEqual(snapshot, {
    connectorId: 'conn-1',
    provider: 'anthropic',
    model: 'claude-opus-custom',
    driverType: 'api',
  });
});

test('buildProgrammerRunSnapshot falls back to task-kind routing', () => {
  const simple = programmerModelForKind('subtask');
  const complex = programmerModelForKind('service');

  assert.notEqual(simple, complex);
  assert.equal(buildProgrammerRunSnapshot({ taskKind: 'subtask', agentRow: { model: 'agent' } }).model, simple);
  assert.equal(buildProgrammerRunSnapshot({ taskKind: 'service', agentRow: { model: 'agent' } }).model, complex);
});

test('buildProgrammerClaimTask preserves runner contract fields', () => {
  const task = buildProgrammerClaimTask({
    row: { id: 'task-1', title: 'Implement', description: null },
    projectCode: 'PROJECT',
    serviceCode: null,
    model: 'claude-sonnet',
    prior: { priorRoleOutputs: [{ role: 'ARCHITECT' }], lastReview: { verdict: 'REWORK' } },
    tools: { capabilities: { modify: true } },
    mcpConfig: { mcpServers: { fs: {} } },
    requiredFields: ['changedFiles', 'result'],
    completionKey: 'programmer-task-1-event-1',
  });

  assert.equal(task.id, 'task-1');
  assert.equal(task.project, 'PROJECT');
  assert.equal(task.service, '');
  assert.equal(task.description, '');
  assert.equal(task.model, 'claude-sonnet');
  assert.deepEqual(task.requiredFields, ['changedFiles', 'result']);
  assert.deepEqual(task.capabilities, { modify: true });
  assert.deepEqual(task.mcpConfig, { mcpServers: { fs: {} } });
  assert.equal(task.completion.tool, 'orchestrator_complete_scanner_task');
  assert.equal(task.completion.completionKey, 'programmer-task-1-event-1');
  assert.equal(task.completion.sourceDocument, 'tasks/claude-tasks.json');
  assert.equal(task.completion.instruction, PROGRAMMER_COMPLETION_INSTRUCTION);
});

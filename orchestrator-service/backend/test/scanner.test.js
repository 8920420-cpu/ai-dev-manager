import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScannerCompletion } from '../src/db.js';

const valid = {
  taskId: '6f83f7aa-5033-48d9-ac7f-3cd90b31cdf7',
  completionKey: '6f83f7aa-5033-48d9-ac7f-3cd90b31cdf7',
  project: 'PS',
  service: 'Chat_Service',
  title: 'Исправить reconnect',
  sourceDocument: '/workspace/claude-tasks.json',
};

test('normalizeScannerCompletion фиксирует следующий этап', () => {
  const result = normalizeScannerCompletion({ ...valid, nextRole: 'GIT_INTEGRATOR' });
  assert.equal(result.nextRole, 'TASK_REVIEWER');
  assert.equal(result.status, 'completed');
});

test('normalizeScannerCompletion требует UUID и координаты сервиса', () => {
  assert.throws(() => normalizeScannerCompletion({ ...valid, taskId: 'T-1' }), /taskId_must_be_uuid/);
  assert.throws(() => normalizeScannerCompletion({ ...valid, service: '' }), /service_required/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStages, STAGE_ERROR, SCANNER_ROLE_CODE } from '../src/stages.js';

// ROLE-NO-EXECUTOR-001 — validateStages запрещает во включённом этапе роль без
// исполнителя (нет в ROLE_FLOW), чтобы задача на этом этапе не зависла тихо.

// Ошибки этапа только про отсутствие исполнителя (отсекаем прочие коды: статус и т.п.).
const executorErrors = (errors) =>
  errors.filter((e) => e.code === STAGE_ERROR.ROLE_NO_EXECUTOR);

test('validateStages: включённый этап с TESTER → stage_role_no_executor', () => {
  const errors = validateStages([
    { id: 's1', name: 'Тестирование', enabled: true, roleCodes: ['TESTER'], taskStatus: 'TESTING' },
  ]);
  const noExec = executorErrors(errors);
  assert.equal(noExec.length, 1);
  assert.equal(noExec[0].stageId, 's1');
  assert.match(noExec[0].message, /TESTER/);
  assert.match(noExec[0].message, /не имеет исполнителя/);
});

test('validateStages: ARCHITECT и PROGRAMMER не дают stage_role_no_executor', () => {
  const errors = validateStages([
    { id: 'a', name: 'Архитектура', enabled: true, roleCodes: ['ARCHITECT'], taskStatus: 'ARCHITECTURE' },
    { id: 'p', name: 'Разработка', enabled: true, roleCodes: ['PROGRAMMER'], taskStatus: 'CODING' },
  ]);
  assert.equal(executorErrors(errors).length, 0);
});

test('validateStages: SCANNER не даёт stage_role_no_executor', () => {
  const errors = validateStages([
    {
      id: 'sc', name: 'Наблюдатель', enabled: true,
      roleCodes: [SCANNER_ROLE_CODE], watchDirectory: '/abs', taskStatus: 'CODING',
    },
  ]);
  assert.equal(executorErrors(errors).length, 0);
});

test('validateStages: отключённый этап с TESTER не даёт stage_role_no_executor', () => {
  const errors = validateStages([
    { id: 's1', name: 'Тестирование', enabled: false, roleCodes: ['TESTER'], taskStatus: 'TESTING' },
  ]);
  assert.equal(executorErrors(errors).length, 0);
});

test('validateStages: управляющие узлы fork/join не падают и не дают stage_role_no_executor', () => {
  const errors = validateStages([
    { id: 'f', name: 'Ветвление', enabled: true, kind: 'fork', roleCodes: ['FORK_GATE'], taskStatus: 'CODING' },
    { id: 'j', name: 'Слияние', enabled: true, kind: 'join', roleCodes: ['JOIN_GATE'], taskStatus: 'CODING' },
  ]);
  assert.ok(Array.isArray(errors));
  assert.equal(executorErrors(errors).length, 0);
});

test('validateStages: condition without role is rejected before it becomes invisible to runner', () => {
  const errors = validateStages([
    { id: 'c', name: 'Condition', enabled: true, kind: 'condition', roleCodes: [], taskStatus: 'TESTING' },
  ]);
  assert.equal(errors.some((e) => e.code === STAGE_ERROR.CONTROL_ROLE_REQUIRED), true);
});

test('validateStages: condition with non-executable role reports stage_role_no_executor', () => {
  const errors = validateStages([
    { id: 'c', name: 'Condition', enabled: true, kind: 'condition', roleCodes: ['FORK_GATE'], taskStatus: 'TESTING' },
  ]);
  const noExec = executorErrors(errors);
  assert.equal(noExec.length, 1);
  assert.equal(noExec[0].stageId, 'c');
});

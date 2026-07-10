import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isFilled,
  validateFieldConsistency,
  extractOutputs,
  missingRequiredInputs,
  SEED_FIELDS,
} from '../src/fieldsContract.js';

test('isFilled: строки/массивы/объекты/числа', () => {
  assert.equal(isFilled(''), false);
  assert.equal(isFilled('   '), false);
  assert.equal(isFilled('x'), true);
  assert.equal(isFilled([]), false);
  assert.equal(isFilled([1]), true);
  assert.equal(isFilled({}), false);
  assert.equal(isFilled({ a: 1 }), true);
  assert.equal(isFilled(0), true);
  assert.equal(isFilled(false), true);
  assert.equal(isFilled(null), false);
  assert.equal(isFilled(undefined), false);
});

test('validateFieldConsistency: вход производится более ранней ролью → ок', () => {
  const route = [{ roleCode: 'ARCHITECT' }, { roleCode: 'PROGRAMMER' }];
  const contracts = {
    ARCHITECT: { inputs: [], outputs: [{ key: 'design' }] },
    PROGRAMMER: { inputs: [{ key: 'design', required: true }], outputs: [{ key: 'diff' }] },
  };
  assert.deepEqual(validateFieldConsistency(route, contracts), []);
});

test('validateFieldConsistency: вход не производится никем → ошибка', () => {
  const route = [{ roleCode: 'PROGRAMMER' }];
  const contracts = { PROGRAMMER: { inputs: [{ key: 'design', required: true }], outputs: [] } };
  const errors = validateFieldConsistency(route, contracts);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, 'design');
  assert.equal(errors[0].roleCode, 'PROGRAMMER');
  assert.equal(errors[0].code, 'field_not_produced_upstream');
});

test('validateFieldConsistency: seed-поле (title/description) считается доступным', () => {
  assert.ok(SEED_FIELDS.includes('title'));
  const route = [{ roleCode: 'ARCHITECT' }];
  const contracts = { ARCHITECT: { inputs: [{ key: 'title', required: true }], outputs: [] } };
  assert.deepEqual(validateFieldConsistency(route, contracts), []);
});

test('validateFieldConsistency: роль НЕ удовлетворяет свой же вход своим выходом', () => {
  const route = [{ roleCode: 'R' }];
  const contracts = { R: { inputs: [{ key: 'x', required: true }], outputs: [{ key: 'x' }] } };
  const errors = validateFieldConsistency(route, contracts);
  assert.equal(errors.length, 1);
});

test('validateFieldConsistency: персистентность — поле с 1-го этапа видно на 3-м (2-й не трогает)', () => {
  const route = [{ roleCode: 'A' }, { roleCode: 'B' }, { roleCode: 'C' }];
  const contracts = {
    A: { inputs: [], outputs: [{ key: 'spec' }] },
    B: { inputs: [], outputs: [{ key: 'other' }] },
    C: { inputs: [{ key: 'spec', required: true }], outputs: [] },
  };
  assert.deepEqual(validateFieldConsistency(route, contracts), []);
});

test('validateFieldConsistency: необязательный вход без производителя → не ошибка', () => {
  const route = [{ roleCode: 'R' }];
  const contracts = { R: { inputs: [{ key: 'opt', required: false }], outputs: [] } };
  assert.deepEqual(validateFieldConsistency(route, contracts), []);
});

test('validateFieldConsistency: контракт строкой-ключом трактуется как required', () => {
  const route = [{ roleCode: 'R' }];
  const contracts = { R: { inputs: ['need'], outputs: [] } };
  const errors = validateFieldConsistency(route, contracts);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, 'need');
});

test('validateFieldConsistency: Map контрактов поддерживается', () => {
  const route = [{ roleCode: 'A' }, { roleCode: 'B' }];
  const contracts = new Map([
    ['A', { inputs: [], outputs: [{ key: 'k' }] }],
    ['B', { inputs: [{ key: 'k', required: true }], outputs: [] }],
  ]);
  assert.deepEqual(validateFieldConsistency(route, contracts), []);
});

test('extractOutputs: берёт заполненные объявленные, собирает пропущенные обязательные', () => {
  const out = extractOutputs(
    { a: 'x', b: '', c: 42, extra: 'ignored' },
    [{ key: 'a', required: true }, { key: 'b', required: true }, { key: 'c', required: false }],
  );
  assert.deepEqual(out.values, { a: 'x', c: 42 });
  assert.deepEqual(out.missingRequired, ['b']);
});

test('extractOutputs: пустой источник → все обязательные пропущены', () => {
  const out = extractOutputs(null, [{ key: 'a', required: true }]);
  assert.deepEqual(out.values, {});
  assert.deepEqual(out.missingRequired, ['a']);
});

test('missingRequiredInputs: карточка покрывает обязательные', () => {
  assert.deepEqual(missingRequiredInputs({ a: 'x' }, [{ key: 'a', required: true }]), []);
  assert.deepEqual(missingRequiredInputs({}, [{ key: 'a', required: true }]), ['a']);
  // seed-поле не считается пропущенным (приходит извне).
  assert.deepEqual(missingRequiredInputs({}, [{ key: 'title', required: true }]), []);
  // необязательное не попадает в пропуски.
  assert.deepEqual(missingRequiredInputs({}, [{ key: 'opt', required: false }]), []);
});

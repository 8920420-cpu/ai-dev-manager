import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFieldInput, normalizeContractInput, FIELD_VALUE_TYPES } from '../src/fields.js';

test('normalizeFieldInput: валидное поле', () => {
  const p = normalizeFieldInput({ key: 'design_doc', name: 'Архитектура', valueType: 'text' });
  assert.equal(p.key, 'design_doc');
  assert.equal(p.name, 'Архитектура');
  assert.equal(p.value_type, 'text');
});

test('normalizeFieldInput: недопустимый key → 422', () => {
  assert.throws(() => normalizeFieldInput({ key: '1bad key', name: 'x' }), /field_key_invalid/);
  assert.throws(() => normalizeFieldInput({ key: '', name: 'x' }), /field_key_invalid/);
});

test('normalizeFieldInput: имя обязательно', () => {
  assert.throws(() => normalizeFieldInput({ key: 'ok', name: '  ' }), /field_name_required/);
});

test('normalizeFieldInput: недопустимый тип → 422', () => {
  assert.throws(() => normalizeFieldInput({ key: 'ok', name: 'n', valueType: 'weird' }), /field_value_type_invalid/);
  assert.ok(FIELD_VALUE_TYPES.includes('json'));
});

test('normalizeFieldInput: partial — только переданные поля', () => {
  const p = normalizeFieldInput({ name: 'Новое имя' }, { partial: true });
  assert.deepEqual(Object.keys(p), ['name']);
});

test('normalizeContractInput: строки и объекты, required по умолчанию true', () => {
  const c = normalizeContractInput({ inputs: ['a', { key: 'b', required: false }], outputs: [{ field: 'c' }] });
  assert.deepEqual(c.inputs, [{ ref: 'a', required: true }, { ref: 'b', required: false }]);
  assert.deepEqual(c.outputs, [{ ref: 'c', required: true }]);
});

test('normalizeContractInput: пустой ref → 422', () => {
  assert.throws(() => normalizeContractInput({ inputs: [{ required: true }], outputs: [] }), /role_field_ref_required/);
});

test('normalizeContractInput: дубликат в колонке → 422', () => {
  assert.throws(() => normalizeContractInput({ inputs: ['a', 'a'], outputs: [] }), /role_field_duplicate/);
});

test('normalizeContractInput: одно и то же поле в обеих колонках допустимо', () => {
  const c = normalizeContractInput({ inputs: ['x'], outputs: ['x'] });
  assert.equal(c.inputs[0].ref, 'x');
  assert.equal(c.outputs[0].ref, 'x');
});

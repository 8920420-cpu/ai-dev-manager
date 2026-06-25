import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGroupName, normalizeSortOrder, ROLE_GROUP_LIMITS } from '../src/roleGroups.js';

test('normalizeGroupName: тримминг и непустота', () => {
  assert.equal(normalizeGroupName('  Разработка  '), 'Разработка');
  assert.throws(() => normalizeGroupName('   '), /role_group_name_required/);
  assert.throws(() => normalizeGroupName(null), /role_group_name_required/);
});

test('normalizeGroupName: ограничение длины', () => {
  const tooLong = 'x'.repeat(ROLE_GROUP_LIMITS.name + 1);
  assert.throws(() => normalizeGroupName(tooLong), /role_group_name_too_long/);
});

test('normalizeSortOrder: null при отсутствии, целое >= 0, иначе ошибка', () => {
  assert.equal(normalizeSortOrder(undefined), null);
  assert.equal(normalizeSortOrder(null), null);
  assert.equal(normalizeSortOrder(0), 0);
  assert.equal(normalizeSortOrder(30), 30);
  assert.throws(() => normalizeSortOrder(-1), /role_group_sort_order_invalid/);
  assert.throws(() => normalizeSortOrder(1.5), /role_group_sort_order_invalid/);
  assert.throws(() => normalizeSortOrder('abc'), /role_group_sort_order_invalid/);
});

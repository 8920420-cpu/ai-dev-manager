import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBool } from '../src/envConfig.js';

test('resolveBool parses common bool values and falls back on garbage', () => {
  assert.equal(resolveBool('B', false, { env: { B: '1' } }).value, true);
  assert.equal(resolveBool('B', false, { env: { B: 'yes' } }).value, true);
  assert.equal(resolveBool('B', true, { env: { B: '0' } }).value, false);
  assert.equal(resolveBool('B', true, { env: { B: 'off' } }).value, false);
  const bad = resolveBool('B', true, { env: { B: 'maybe' } });
  assert.equal(bad.value, true);
  assert.ok(bad.warning);
});

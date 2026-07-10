import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { round, makeRunId, toReturnPath } from '../src/util.js';

test('round округляет до заданного числа знаков', () => {
  assert.equal(round(1.23456, 2), 1.23);
  assert.equal(round(1.999, 0), 2);
  assert.equal(round(12, 2), 12);
});

test('makeRunId формирует имя вида YYYY-MM-DDTHH-mm-ss без двоеточий', () => {
  const id = makeRunId(new Date(2026, 5, 21, 14, 22, 15)); // месяцы с 0
  assert.equal(id, '2026-06-21T14-22-15');
  assert.ok(!id.includes(':'));
});

test('makeRunId дополняет нулями', () => {
  const id = makeRunId(new Date(2026, 0, 1, 3, 4, 5));
  assert.equal(id, '2026-01-01T03-04-05');
});

test('toReturnPath возвращает относительный путь с прямыми слэшами', () => {
  const cwd = process.cwd();
  const abs = path.join(cwd, '.tmp', 'pipeline-results', 'run1');
  assert.equal(toReturnPath(abs, cwd), '.tmp/pipeline-results/run1');
});

test('toReturnPath возвращает абсолютный путь, если он вне cwd', () => {
  const cwd = path.resolve('/a/b/c');
  const abs = path.resolve('/x/y/z');
  assert.equal(toReturnPath(abs, cwd), abs);
});

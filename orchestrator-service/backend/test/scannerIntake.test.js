import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScannerIntake } from '../src/db.js';

test('normalizeScannerIntake: валидный вход нормализуется', () => {
  const out = normalizeScannerIntake({
    externalId: '  INTEGRATION-P1.5 ',
    project: ' ai-dev-manager ',
    title: ' Заголовок ',
    service: ' INTEGRATION ',
    description: ' тело ',
    result: 'готово',
    changedFiles: ['a.js', 2],
  });
  assert.equal(out.externalId, 'INTEGRATION-P1.5');
  assert.equal(out.project, 'ai-dev-manager');
  assert.equal(out.title, 'Заголовок');
  assert.equal(out.service, 'INTEGRATION');
  assert.equal(out.description, 'тело');
  assert.equal(out.result, 'готово');
  assert.deepEqual(out.changedFiles, ['a.js', '2']);
});

test('normalizeScannerIntake: service/description пустые → service "", description null', () => {
  const out = normalizeScannerIntake({ externalId: 'X', project: 'p', title: 't' });
  assert.equal(out.service, '');
  assert.equal(out.description, null);
  assert.deepEqual(out.changedFiles, []);
});

for (const key of ['externalId', 'project', 'title']) {
  test(`normalizeScannerIntake: без ${key} → 422 ${key}_required`, () => {
    const base = { externalId: 'X', project: 'p', title: 't' };
    delete base[key];
    assert.throws(() => normalizeScannerIntake(base), (e) => {
      assert.equal(e.statusCode, 422);
      assert.equal(e.message, `${key}_required`);
      return true;
    });
  });
}

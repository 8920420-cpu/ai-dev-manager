import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScannerIntake, looksCorruptedText } from '../src/db.js';

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

test('normalizeScannerIntake: projectPath приоритетнее project', () => {
  const out = normalizeScannerIntake({
    externalId: 'X', title: 't', project: 'code-x', projectPath: ' /abs/path/proj ',
  });
  assert.equal(out.project, '/abs/path/proj');
});

test('normalizeScannerIntake: без проекта → project "" (станет неразобранной)', () => {
  const out = normalizeScannerIntake({ externalId: 'X', title: 't' });
  assert.equal(out.project, '');
});

test('looksCorruptedText: чистый текст не считается порчей', () => {
  assert.equal(looksCorruptedText('Заголовок задачи'), false);
  assert.equal(looksCorruptedText('Self-test of the tool loop v3'), false);
  assert.equal(looksCorruptedText('Готово?'), false);          // одиночный «?»
  assert.equal(looksCorruptedText('Что делать??'), false);     // двойной «?»
  assert.equal(looksCorruptedText(''), false);
  assert.equal(looksCorruptedText(null), false);
});

test('looksCorruptedText: mojibake распознаётся', () => {
  assert.equal(looksCorruptedText('������������ ����� v2'), true);          // U+FFFD
  assert.equal(looksCorruptedText('?????? ?????? ????? ???'), true);        // схлопнуто в «?»
  assert.equal(looksCorruptedText('????????? ? ??????? legacy-??????'), true);
});

test('normalizeScannerIntake: битый title → 422 corrupted_encoding', () => {
  assert.throws(
    () => normalizeScannerIntake({ externalId: 'X', title: '?????? ?????? ?????' }),
    (e) => { assert.equal(e.statusCode, 422); assert.equal(e.message, 'corrupted_encoding'); return true; },
  );
});

test('normalizeScannerIntake: битый description → 422 corrupted_encoding', () => {
  assert.throws(
    () => normalizeScannerIntake({ externalId: 'X', title: 'Нормальный заголовок', description: '������ ����' }),
    (e) => { assert.equal(e.statusCode, 422); assert.equal(e.message, 'corrupted_encoding'); return true; },
  );
});

// Проект больше НЕ обязателен: нераспознанный/пустой делает задачу неразобранной.
for (const key of ['externalId', 'title']) {
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

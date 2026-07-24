import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize,
  signatureTokens,
  scoreMatch,
  matchRejected,
} from '../src/antiRegression.js';

// ── tokenize / signatureTokens ─────────────────────────────────────────────────

test('tokenize: нижний регистр, отсев пунктуации и коротких токенов', () => {
  const t = tokenize('Разделение Чтения, и Записи — через APP reader!');
  // «и», «—» и пунктуация уходят; всё в нижнем регистре.
  assert.deepEqual(t, ['разделение', 'чтения', 'записи', 'app', 'reader']);
});

test('tokenize: стоп-слова (RU+EN) отсеиваются', () => {
  const t = tokenize('the app to for и на не with reader');
  assert.deepEqual(t, ['app', 'reader']);
});

test('tokenize: детерминированность (одинаковый вход → одинаковый выход)', () => {
  const input = 'добавить кнопку экспорта в отчёт';
  assert.deepEqual(tokenize(input), tokenize(input));
});

test('tokenize: пустой/невалидный вход → []', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(undefined), []);
});

test('signatureTokens: уникальные, отсортированные, детерминированные', () => {
  const s = signatureTokens('reader app reader APP разделение');
  assert.deepEqual(s, ['app', 'reader', 'разделение']);
  // Порядок стабилен независимо от порядка слов на входе.
  assert.deepEqual(signatureTokens('app reader'), signatureTokens('reader app'));
});

// ── scoreMatch (Jaccard) ───────────────────────────────────────────────────────

test('scoreMatch: одинаковые множества → 1', () => {
  const a = signatureTokens('разделение чтения записи');
  assert.equal(scoreMatch(a, a), 1);
});

test('scoreMatch: непересекающиеся множества → 0', () => {
  const a = signatureTokens('разделение чтения записи');
  const b = signatureTokens('кнопка экспорта отчёт');
  assert.equal(scoreMatch(a, b), 0);
});

test('scoreMatch: пустые множества → 0', () => {
  assert.equal(scoreMatch([], ['app']), 0);
  assert.equal(scoreMatch(['app'], []), 0);
  assert.equal(scoreMatch([], []), 0);
});

test('scoreMatch: частичное пересечение (Jaccard = |A∩B|/|A∪B|)', () => {
  // A={app,reader,x}, B={app,reader,y}: пересечение 2, объединение 4 → 0.5.
  const score = scoreMatch(['app', 'reader', 'foobar'], ['app', 'reader', 'quux']);
  assert.equal(score, 0.5);
});

// ── matchRejected ──────────────────────────────────────────────────────────────

const rejectedDecisions = [
  {
    decision_id: 'read-write-split',
    area: 'db',
    status: 'rejected',
    title: 'Разделение чтения и записи',
    problem_signature: 'разделение чтения записи app reader неэффективно',
    approach: 'разделение чтения и записи через app reader',
    reason: 'переведённых операций ноль, решает размещение пода',
    alternatives: '',
    forbidden: '',
    superseded_by: '',
  },
];

test('matchRejected: похожий подход в той же области → flagged, score>=threshold', () => {
  const candidate = { text: 'давай сделаем разделение чтения и записи через app reader', area: 'db' };
  const found = matchRejected(candidate, rejectedDecisions, { threshold: 0.45, limit: 5 });
  assert.equal(found.length, 1);
  assert.equal(found[0].decision.decision_id, 'read-write-split');
  assert.ok(found[0].score >= 0.45, `score ${found[0].score} должен быть >= 0.45`);
});

test('matchRejected: несвязанный подход → пусто', () => {
  const candidate = { text: 'добавить кнопку экспорта в отчёт' };
  const found = matchRejected(candidate, rejectedDecisions, { threshold: 0.45, limit: 5 });
  assert.deepEqual(found, []);
});

test('matchRejected: пустой реестр → пусто', () => {
  const candidate = { text: 'разделение чтения и записи через app reader', area: 'db' };
  assert.deepEqual(matchRejected(candidate, [], { threshold: 0.45 }), []);
});

test('matchRejected: пустой текст кандидата → пусто', () => {
  assert.deepEqual(matchRejected({ text: '' }, rejectedDecisions, {}), []);
});

test('matchRejected: соблюдает limit и сортировку по score desc', () => {
  const many = [
    { decision_id: 'low', area: 'x', status: 'rejected', approach: 'разделение чтения' },
    { decision_id: 'high', area: 'x', status: 'rejected', approach: 'разделение чтения записи app reader' },
  ];
  const candidate = { text: 'разделение чтения записи app reader' };
  const found = matchRejected(candidate, many, { threshold: 0.1, limit: 1 });
  assert.equal(found.length, 1);
  assert.equal(found[0].decision.decision_id, 'high');
});

test('matchRejected: бонус за совпадение области поднимает score', () => {
  const decisions = [
    { decision_id: 'd', area: 'db', status: 'rejected', approach: 'разделение чтения записи app reader lorem ipsum' },
  ];
  const candidate = { text: 'разделение чтения записи app reader dolor sit' };
  const withArea = matchRejected({ ...candidate, area: 'db' }, decisions, { threshold: 0.1 });
  const withoutArea = matchRejected({ ...candidate, area: 'other' }, decisions, { threshold: 0.1 });
  assert.ok(withArea[0].score > withoutArea[0].score, 'бонус за область должен повышать score');
});

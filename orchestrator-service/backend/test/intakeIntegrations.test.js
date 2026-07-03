import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashToken,
  generateToken,
  redactIntegration,
  normalizeIntegrationInput,
} from '../src/intakeIntegrations.js';
import { normalizeIntakeReport, buildIntakeReportContext } from '../src/db.js';

// --- hashToken --------------------------------------------------------------
test('hashToken: стабильный SHA-256 hex, пустой вход → ""', () => {
  const h = hashToken('secret-token');
  assert.equal(h, hashToken('secret-token'));       // детерминирован
  assert.match(h, /^[0-9a-f]{64}$/);                 // 64 hex-символа
  assert.notEqual(h, hashToken('other'));            // разный вход → разный хэш
  assert.equal(hashToken(''), '');
  assert.equal(hashToken('   '), '');
  assert.equal(hashToken(null), '');
});

// --- generateToken ----------------------------------------------------------
test('generateToken: префикс itk_ + 48 hex, каждый раз новый', () => {
  const t1 = generateToken();
  const t2 = generateToken();
  assert.match(t1, /^itk_[0-9a-f]{48}$/);
  assert.notEqual(t1, t2);
  assert.match(hashToken(t1), /^[0-9a-f]{64}$/);
});

// --- redactIntegration ------------------------------------------------------
test('redactIntegration: скрывает tokenHash, отдаёт флаг hasToken', () => {
  const withToken = redactIntegration({ id: '1', name: 'PS', tokenHash: 'abc' });
  assert.equal(withToken.tokenHash, undefined);
  assert.equal(withToken.hasToken, true);
  assert.equal(withToken.name, 'PS');
  const noToken = redactIntegration({ id: '2', name: 'X', tokenHash: '' });
  assert.equal(noToken.hasToken, false);
});

// --- normalizeIntegrationInput ---------------------------------------------
test('normalizeIntegrationInput: дефолты при создании', () => {
  const v = normalizeIntegrationInput({ name: '  PS-чат  ' });
  assert.equal(v.name, 'PS-чат');
  assert.equal(v.enabled, true);
  assert.equal(v.rateLimitPerMin, 60);
  assert.equal(v.userRateLimitPerMin, 20);
  assert.equal(v.minMessageLength, 10);
});

test('normalizeIntegrationInput: числа клампятся, enabled=false уважается', () => {
  const v = normalizeIntegrationInput({
    name: 'X', enabled: false, rateLimitPerMin: -5, userRateLimitPerMin: 0, minMessageLength: -3,
  });
  assert.equal(v.enabled, false);
  assert.equal(v.rateLimitPerMin, 1);        // min 1
  assert.equal(v.userRateLimitPerMin, 1);    // min 1
  assert.equal(v.minMessageLength, 0);       // min 0
});

test('normalizeIntegrationInput: partial трогает только присланные поля', () => {
  const v = normalizeIntegrationInput({ enabled: false }, { partial: true });
  assert.deepEqual(Object.keys(v), ['enabled']);
  assert.equal(v.enabled, false);
});

test('normalizeIntegrationInput: нечисловой rate → дефолт', () => {
  const v = normalizeIntegrationInput({ name: 'X', rateLimitPerMin: 'abc' });
  assert.equal(v.rateLimitPerMin, 60);
});

// --- normalizeIntakeReport (приём обращения) --------------------------------
test('normalizeIntakeReport: валидный вход нормализуется', () => {
  const out = normalizeIntakeReport({
    token: '  itk_abc  ',
    externalId: '  RPT-1  ',
    message: '  Кнопка отправки не работает на форме заказа  ',
    user: '  ivan  ',
    service: '  ps-chat  ',
    form: '  OrderForm  ',
    autocontext: {
      url: 'https://app/x', buildVersion: '1.2.3', userAgent: 'UA',
      timestamp: '2026-07-03T00:00:00Z', jsErrors: ['TypeError', 2], lastFailedApiRequestId: 'req-9',
    },
    screenshotUrl: '  minio://bucket/shot.png  ',
  });
  assert.equal(out.token, 'itk_abc');
  assert.equal(out.externalId, 'RPT-1');
  assert.equal(out.user, 'ivan');
  assert.equal(out.service, 'ps-chat');
  assert.equal(out.form, 'OrderForm');
  assert.equal(out.screenshotUrl, 'minio://bucket/shot.png');
  assert.equal(out.autocontext.url, 'https://app/x');
  assert.deepEqual(out.autocontext.jsErrors, ['TypeError', '2']);
  assert.equal(out.autocontext.lastFailedApiRequestId, 'req-9');
});

test('normalizeIntakeReport: пустой autocontext → поля null, jsErrors []', () => {
  const out = normalizeIntakeReport({ token: 't', externalId: 'e', message: 'достаточно длинное', user: 'u' });
  assert.equal(out.service, '');
  assert.equal(out.form, '');
  assert.equal(out.screenshotUrl, null);
  assert.equal(out.autocontext.url, null);
  assert.deepEqual(out.autocontext.jsErrors, []);
});

test('normalizeIntakeReport: без токена → 401 token_required', () => {
  assert.throws(
    () => normalizeIntakeReport({ externalId: 'e', message: 'msg', user: 'u' }),
    (e) => { assert.equal(e.statusCode, 401); assert.equal(e.message, 'token_required'); return true; },
  );
});

for (const [key, code] of [['externalId', 'external_id_required'], ['message', 'message_required'], ['user', 'user_required']]) {
  test(`normalizeIntakeReport: без ${key} → 422 ${code}`, () => {
    const base = { token: 't', externalId: 'e', message: 'msg', user: 'u' };
    delete base[key];
    assert.throws(
      () => normalizeIntakeReport(base),
      (e) => { assert.equal(e.statusCode, 422); assert.equal(e.message, code); return true; },
    );
  });
}

test('normalizeIntakeReport: битый текст сообщения → 422 corrupted_encoding', () => {
  assert.throws(
    () => normalizeIntakeReport({ token: 't', externalId: 'e', message: '?????? ?????? ?????', user: 'u' }),
    (e) => { assert.equal(e.statusCode, 422); assert.equal(e.message, 'corrupted_encoding'); return true; },
  );
});

// --- normalizeIntakeReport: category (INTAKE-CATEGORY-VALIDATION-001) --------
const baseReport = { token: 't', externalId: 'e', message: 'достаточно длинное сообщение', user: 'u' };

for (const category of ['bug', 'idea', 'feature', 'question']) {
  test(`normalizeIntakeReport: валидная category=${category} сохраняется`, () => {
    const out = normalizeIntakeReport({ ...baseReport, category });
    assert.equal(out.category, category);
  });
}

test('normalizeIntakeReport: category нормализуется (регистр/пробелы)', () => {
  assert.equal(normalizeIntakeReport({ ...baseReport, category: '  BUG  ' }).category, 'bug');
});

test('normalizeIntakeReport: невалидная category → null (приём не роняет)', () => {
  assert.equal(normalizeIntakeReport({ ...baseReport, category: 'urgent' }).category, null);
  assert.equal(normalizeIntakeReport({ ...baseReport, category: 123 }).category, null);
});

test('normalizeIntakeReport: пустая/отсутствующая category → null', () => {
  assert.equal(normalizeIntakeReport({ ...baseReport, category: '   ' }).category, null);
  assert.equal(normalizeIntakeReport(baseReport).category, null);
});

// --- buildIntakeReportContext (INTAKE-INTEGRATIONS-001) ---------------------
const sampleCard = {
  reportNumber: 42,
  integration: 'PS-чат',
  reporterUser: 'ivan',
  reporterService: 'ps-chat',
  reporterForm: 'OrderForm',
  category: 'bug',
  autocontext: {
    url: 'https://app/order', buildVersion: '1.2.3', userAgent: 'UA',
    timestamp: '2026-07-03T00:00:00Z', jsErrors: ['E1', 'E2'], lastFailedApiRequestId: 'req-9',
  },
  screenshotUrl: 'minio://bucket/shot.png',
};

test('buildIntakeReportContext: блок собирается для задачи-обращения под Приёмщиком', () => {
  const r = buildIntakeReportContext(sampleCard, { roleCode: 'TASK_INTAKE_OFFICER', isIntakeTask: true });
  assert.ok(r);
  assert.equal(r.reportNumber, 42);
  assert.equal(r.reporterService, 'ps-chat');
  assert.equal(r.reporterForm, 'OrderForm');
  assert.equal(r.category, 'bug');
  assert.equal(r.autocontext.url, 'https://app/order');
  assert.equal(r.autocontext.lastFailedApiRequestId, 'req-9');
  assert.deepEqual(r.autocontext.jsErrors, ['E1', 'E2']);
  assert.equal(r.screenshotUrl, 'minio://bucket/shot.png');
});

test('buildIntakeReportContext: null для не-Приёмщика', () => {
  assert.equal(buildIntakeReportContext(sampleCard, { roleCode: 'ARCHITECT', isIntakeTask: true }), null);
});

test('buildIntakeReportContext: null для НЕ задачи-обращения', () => {
  assert.equal(buildIntakeReportContext(sampleCard, { roleCode: 'TASK_INTAKE_OFFICER', isIntakeTask: false }), null);
});

test('buildIntakeReportContext: jsErrors капятся первыми 10 строками, каждая по длине', () => {
  const jsErrors = Array.from({ length: 25 }, (_, i) => `err-${i}`);
  jsErrors[0] = 'x'.repeat(1000);
  const r = buildIntakeReportContext(
    { autocontext: { jsErrors } },
    { roleCode: 'TASK_INTAKE_OFFICER', isIntakeTask: true },
  );
  assert.equal(r.autocontext.jsErrors.length, 10);           // не больше 10 строк
  assert.ok(r.autocontext.jsErrors[0].length <= 300);        // каждая строка капнута
  assert.ok(r.autocontext.jsErrors[0].endsWith('…'));        // длинная строка обрезана
  assert.equal(r.autocontext.jsErrors[1], 'err-1');
});

test('buildIntakeReportContext: пустой/битый data_card не роняет (поля → null/[])', () => {
  const r = buildIntakeReportContext(null, { roleCode: 'TASK_INTAKE_OFFICER', isIntakeTask: true });
  assert.ok(r);
  assert.equal(r.reportNumber, null);
  assert.equal(r.category, null);
  assert.equal(r.autocontext.url, null);
  assert.deepEqual(r.autocontext.jsErrors, []);
});

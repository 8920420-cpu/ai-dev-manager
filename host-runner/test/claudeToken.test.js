import test from 'node:test';
import assert from 'node:assert/strict';
import { setupClaudeToken, isValidToken, maskToken } from '../src/claudeToken.js';

const VALID = `sk-ant-oat01-${'A1b2C3d4E5f6G7h8'.repeat(2)}_-xyz`;

test('isValidToken: принимает sk-ant-oat01-…, отвергает мусор', () => {
  assert.equal(isValidToken(VALID), true);
  assert.equal(isValidToken('sk-ant-api03-whatever'), false);
  assert.equal(isValidToken('просто строка'), false);
  assert.equal(isValidToken(''), false);
});

test('maskToken: прячет середину', () => {
  const m = maskToken(VALID);
  assert.match(m, /^sk-ant-oat01/);
  assert.ok(m.includes('…'));
  assert.ok(!m.includes('A1b2C3d4E5f6G7h8A1b2'));
});

test('setupClaudeToken: ручной валидный токен → сохранён, source=manual', async () => {
  let saved = null;
  const res = await setupClaudeToken(
    { token: `  ${VALID}  ` },
    { saveToken: async (t) => { saved = t; return '/tmp/token'; } },
  );
  assert.equal(res.ok, true);
  assert.equal(res.source, 'manual');
  assert.equal(res.savedTo, '/tmp/token');
  assert.equal(saved, VALID, 'токен триммится перед сохранением');
});

test('setupClaudeToken: ручной невалидный токен → ошибка invalid_token, не сохраняем', async () => {
  let called = false;
  await assert.rejects(
    () => setupClaudeToken({ token: 'не-токен' }, { saveToken: async () => { called = true; return 'x'; } }),
    (e) => e.code === 'invalid_token',
  );
  assert.equal(called, false);
});

test('setupClaudeToken: без токена → запускает setup-token, ловит и сохраняет', async () => {
  let saved = null;
  const res = await setupClaudeToken(
    {},
    {
      runSetupToken: async () => VALID,
      saveToken: async (t) => { saved = t; return '/tmp/token'; },
    },
  );
  assert.equal(res.source, 'setup-token');
  assert.equal(saved, VALID);
});

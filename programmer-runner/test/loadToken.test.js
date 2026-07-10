import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureClaudeToken, tokenFilePath } from '../src/loadToken.js';

test('ensureClaudeToken: есть ANTHROPIC_API_KEY → ничего не подхватываем', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-api' };
  const r = ensureClaudeToken(env, () => { throw new Error('не должно читаться'); });
  assert.equal(r.loaded, false);
  assert.equal(r.source, 'api_key');
});

test('ensureClaudeToken: уже есть CLAUDE_CODE_OAUTH_TOKEN → не трогаем', () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' };
  const r = ensureClaudeToken(env, () => { throw new Error('не должно читаться'); });
  assert.equal(r.loaded, false);
  assert.equal(r.source, 'env_oauth_token');
});

test('ensureClaudeToken: ни ключа, ни токена → читает файл и выставляет env', () => {
  const env = {};
  const r = ensureClaudeToken(env, () => '  sk-ant-oat01-fromfile  \n');
  assert.equal(r.loaded, true);
  assert.equal(r.source, 'token_file');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-fromfile');
});

test('ensureClaudeToken: файла нет → loaded=false, env не трогаем', () => {
  const env = {};
  const r = ensureClaudeToken(env, () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
  assert.equal(r.loaded, false);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('tokenFilePath: PROGRAMMER_TOKEN_FILE переопределяет путь', () => {
  assert.equal(tokenFilePath({ PROGRAMMER_TOKEN_FILE: '/custom/tok' }), '/custom/tok');
});

// MCP-ROLES-001 — юнит-тесты чистых функций раздела «MCP роли».
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMcpRoleCreate,
  normalizeMcpRoleUpdate,
  mapMcpRole,
  MCP_ROLE_LIMITS,
} from '../src/mcpRoles.js';

test('normalizeMcpRoleCreate: валидная роль с промтом и требованиями', () => {
  const r = normalizeMcpRoleCreate({
    code: 'MCP_REVIEWER',
    name: 'MCP Reviewer',
    description: 'Роль ревью',
    prompt: 'Ты — ревьюер.',
    requirements: 'Доступ на чтение репозитория.',
  });
  assert.equal(r.code, 'MCP_REVIEWER');
  assert.equal(r.name, 'MCP Reviewer');
  assert.equal(r.description, 'Роль ревью');
  assert.equal(r.prompt, 'Ты — ревьюер.');
  assert.equal(r.requirements, 'Доступ на чтение репозитория.');
});

test('normalizeMcpRoleCreate: code обязателен', () => {
  assert.throws(() => normalizeMcpRoleCreate({ name: 'X' }), /mcp_role_code_required/);
  assert.throws(() => normalizeMcpRoleCreate({ code: '  ', name: 'X' }), /mcp_role_code_required/);
});

test('normalizeMcpRoleCreate: недопустимый code → 422', () => {
  assert.throws(() => normalizeMcpRoleCreate({ code: '1bad', name: 'X' }), /mcp_role_code_invalid/);
  assert.throws(() => normalizeMcpRoleCreate({ code: 'bad code', name: 'X' }), /mcp_role_code_invalid/);
});

test('normalizeMcpRoleCreate: name обязателен', () => {
  assert.throws(() => normalizeMcpRoleCreate({ code: 'OK', name: '  ' }), /mcp_role_name_required/);
});

test('normalizeMcpRoleCreate: пустые опциональные поля → null', () => {
  const r = normalizeMcpRoleCreate({ code: 'OK', name: 'Ok', prompt: '   ', requirements: '' });
  assert.equal(r.prompt, null);
  assert.equal(r.requirements, null);
  assert.equal(r.description, null);
});

test('normalizeMcpRoleCreate: слишком длинный промт → 422', () => {
  const prompt = 'x'.repeat(MCP_ROLE_LIMITS.prompt + 1);
  assert.throws(() => normalizeMcpRoleCreate({ code: 'OK', name: 'Ok', prompt }), /mcp_role_prompt_too_long/);
});

test('normalizeMcpRoleCreate: слишком длинные требования → 422', () => {
  const requirements = 'y'.repeat(MCP_ROLE_LIMITS.requirements + 1);
  assert.throws(
    () => normalizeMcpRoleCreate({ code: 'OK', name: 'Ok', requirements }),
    /mcp_role_requirements_too_long/,
  );
});

test('normalizeMcpRoleUpdate: partial — только переданные поля', () => {
  const p = normalizeMcpRoleUpdate({ requirements: 'Новые требования' });
  assert.deepEqual(Object.keys(p), ['requirements']);
  assert.equal(p.requirements, 'Новые требования');
});

test('normalizeMcpRoleUpdate: пустой name → 422', () => {
  assert.throws(() => normalizeMcpRoleUpdate({ name: '  ' }), /mcp_role_name_required/);
});

test('normalizeMcpRoleUpdate: очистка промта передаётся как null', () => {
  const p = normalizeMcpRoleUpdate({ prompt: '' });
  assert.ok('prompt' in p);
  assert.equal(p.prompt, null);
});

test('mapMcpRole: строка БД → DTO с дефолтами', () => {
  assert.deepEqual(
    mapMcpRole({ code: 'A', name: 'A', description: null, prompt: null, requirements: null, is_mcp_role: true }),
    { code: 'A', name: 'A', description: '', prompt: '', requirements: '', isMcpRole: true },
  );
  const full = mapMcpRole({
    code: 'B', name: 'B', description: 'd', prompt: 'p', requirements: 'r', is_mcp_role: true,
  });
  assert.equal(full.requirements, 'r');
  assert.equal(full.isMcpRole, true);
});

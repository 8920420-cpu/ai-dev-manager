// MCP-SERVICE-001 — тесты HTTP-клиента tools-service (с мок-fetch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolsClient } from '../src/toolsClient.js';

function fakeFetch(impl) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: '', text: async () => JSON.stringify(body) };
}

test('execute: успешный вызов разворачивает result в data и шлёт tool+args', async () => {
  const fetchImpl = fakeFetch((url, init) => {
    assert.equal(url, 'http://t/execute');
    const body = JSON.parse(init.body);
    assert.equal(body.tool, 'read_file');
    assert.deepEqual(body.args, { root: '/r', path: 'a.txt' });
    return jsonResponse(200, { ok: true, tool: 'read_file', result: { content: 'hi' } });
  });
  const client = createToolsClient({ baseUrl: 'http://t', fetchImpl });
  const r = await client.execute('read_file', { root: '/r', path: 'a.txt' });
  assert.deepEqual(r, { ok: true, data: { content: 'hi' } });
});

test('execute: app-level ok:false (200) нормализуется в ошибку без падения', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { ok: false, tool: 'read_file', code: 'not_found', error: 'нет файла' }));
  const client = createToolsClient({ baseUrl: 'http://t', fetchImpl });
  const r = await client.execute('read_file', { root: '/r', path: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_found');
  assert.equal(r.error, 'нет файла');
});

test('execute: HTTP 404 нормализуется в { ok:false }', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(404, { ok: false, error: 'not_found', code: 'unknown_tool' }));
  const client = createToolsClient({ baseUrl: 'http://t', fetchImpl });
  const r = await client.execute('nope', { root: '/r' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(r.code, 'unknown_tool');
});

test('execute: сетевая ошибка возвращает результат, не бросает', async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error('ECONNREFUSED');
  });
  const client = createToolsClient({ baseUrl: 'http://t', fetchImpl });
  const r = await client.execute('read_file', { root: '/r', path: 'a' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'network_error');
});

test('execute: добавляет Bearer-заголовок при наличии токена', async () => {
  const fetchImpl = fakeFetch((url, init) => {
    assert.equal(init.headers.authorization, 'Bearer tkn');
    return jsonResponse(200, { ok: true, result: {} });
  });
  const client = createToolsClient({ baseUrl: 'http://t', token: 'tkn', fetchImpl });
  await client.execute('list_dir', { root: '/r' });
});

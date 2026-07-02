import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpDispatch } from '../src/httpDispatch.js';

test('отправляет completion с токеном', async () => {
  let request;
  const dispatch = createHttpDispatch({
    endpoint: 'http://orchestrator/api/scanner/task-completed',
    token: 'secret',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response('{"accepted":true}', { status: 200 });
    },
  });
  const result = await dispatch({ taskId: 'T' });
  assert.equal(request.options.headers.authorization, 'Bearer secret');
  assert.equal(result.accepted, true);
});

test('ошибка API не считается успешной доставкой', async () => {
  const dispatch = createHttpDispatch({
    endpoint: 'http://orchestrator/api',
    fetchImpl: async () => new Response('bad task', { status: 422 }),
  });
  await assert.rejects(() => dispatch({ taskId: 'T' }), /422: bad task/);
});

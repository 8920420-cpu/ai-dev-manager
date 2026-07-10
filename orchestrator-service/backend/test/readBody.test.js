import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.ORCHESTRATOR_API_TOKEN = process.env.ORCHESTRATOR_API_TOKEN || 'test-token';
const { readBody } = await import('../src/server.js');

// Фейковый req: эмитит заранее заданные Buffer-чанки, затем 'end'.
function fakeReq(chunks) {
  const req = new EventEmitter();
  queueMicrotask(() => {
    for (const c of chunks) req.emit('data', c);
    req.emit('end');
  });
  return req;
}

test('readBody: многобайтовый символ на границе чанков НЕ ломается', async () => {
  // JSON с кириллицей; режем по байтам так, чтобы UTF-8 символ оказался разорван.
  const json = JSON.stringify({ title: 'Заголовок задачи', description: 'тело' });
  const full = Buffer.from(json, 'utf8');
  // Граница 1 байт — гарантированно середина первого кириллического символа.
  const a = full.subarray(0, 11);
  const b = full.subarray(11);
  const body = await readBody(fakeReq([a, b]));
  assert.equal(body.title, 'Заголовок задачи');
  assert.equal(body.description, 'тело');
});

test('readBody: один чанк целиком', async () => {
  const body = await readBody(fakeReq([Buffer.from('{"x":"тест"}', 'utf8')]));
  assert.equal(body.x, 'тест');
});

test('readBody: пустое тело → {}', async () => {
  const body = await readBody(fakeReq([]));
  assert.deepEqual(body, {});
});

test('readBody: битый JSON → reject 400 invalid_json', async () => {
  await assert.rejects(
    () => readBody(fakeReq([Buffer.from('{not json', 'utf8')])),
    (e) => /invalid JSON body/.test(e.message) && e.statusCode === 400 && e.code === 'invalid_json',
  );
});

test('readBody: тело больше лимита → reject 413, ровно один settle', async () => {
  const big = Buffer.alloc(1e6 + 10, 0x61); // > 1 МБ — превышает лимит сразу
  let settles = 0;
  await readBody(fakeReq([big, big, big])).then(
    () => { settles++; },
    (e) => {
      settles++;
      assert.equal(e.statusCode, 413);
      assert.equal(e.code, 'payload_too_large');
    },
  );
  // Последующие data/end не должны повторно резолвить/реджектить промис.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(settles, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CommandExecutor } from '../src/CommandExecutor.js';

const exec = new CommandExecutor();

test('успешная команда: exitCode 0 и захват stdout', async () => {
  const res = await exec.run('echo marker_42');
  assert.equal(res.exitCode, 0);
  assert.equal(res.timedOut, false);
  assert.equal(res.error, null);
  assert.match(res.stdout, /marker_42/);
  assert.ok(res.durationSeconds >= 0);
});

test('падающая команда возвращает ненулевой код', async () => {
  const res = await exec.run('exit 3');
  assert.equal(res.exitCode, 3);
  assert.equal(res.timedOut, false);
});

test('onStdout получает потоковые данные', async () => {
  let captured = '';
  await exec.run('echo streamed_value', { onStdout: (s) => (captured += s) });
  assert.match(captured, /streamed_value/);
});

test('таймаут прерывает долгую команду и помечает timedOut', async () => {
  // node гарантированно доступен и кроссплатформенен
  const res = await exec.run('node -e "setTimeout(()=>{}, 10000)"', { timeoutMs: 300 });
  assert.equal(res.timedOut, true);
  assert.notEqual(res.exitCode, 0);
});

test('ошибка запуска несуществующего бинарника не роняет промис', async () => {
  const res = await exec.run('this_binary_should_not_exist_12345');
  // shell вернёт ненулевой код (команда не найдена) — промис всё равно резолвится
  assert.notEqual(res.exitCode, 0);
  assert.equal(res.timedOut, false);
});

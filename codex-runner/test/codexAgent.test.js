// Тесты формы вызова `codex exec` без живой модели: инъектируем fake-spawn и
// проверяем флаги/cwd/stdin. Реальный прогон codex покрыт ручным smoke-тестом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { makeCodexRunAgent } from '../src/codexAgent.js';

// Фейковый дочерний процесс: запоминает stdin, эмитит close с заданным кодом.
function fakeSpawn(captured, { code = 0 } = {}) {
  return (bin, args, opts) => {
    captured.bin = bin;
    captured.args = args;
    captured.opts = opts;
    captured.stdin = '';
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
    proc.stdin = { write: (s) => { captured.stdin += s; }, end: () => {} };
    proc.kill = () => { captured.killed = true; };
    setImmediate(() => proc.emit('close', code));
    return proc;
  };
}

const task = {
  id: 't1', role: 'ARCHITECT', projectPath: 'K:\\Роботы\\проект с пробелом',
  systemPrompt: 'SYS', userPrompt: 'USR',
  outputSchema: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } },
};

test('codexAgent: корень проекта — через cwd процесса, без аргумента -C', async () => {
  const cap = {};
  const run = makeCodexRunAgent({ spawn: fakeSpawn(cap), log: { warn() {} } });
  await run(task, {});
  assert.equal(cap.opts.cwd, task.projectPath, 'projectPath передан как cwd');
  assert.ok(!cap.args.includes('-C'), 'аргумента -C нет (путь с кириллицей/пробелом не идёт через shell)');
});

test('codexAgent: ключевые флаги exec/json/schema/sandbox + промпт в stdin', async () => {
  const cap = {};
  const run = makeCodexRunAgent({ spawn: fakeSpawn(cap), sandbox: 'read-only', log: { warn() {} } });
  await run(task, {});
  assert.equal(cap.args[0], 'exec');
  assert.ok(cap.args.includes('--json'));
  assert.ok(cap.args.includes('--output-schema'));
  assert.ok(cap.args.includes('--skip-git-repo-check'));
  const si = cap.args.indexOf('-s');
  assert.equal(cap.args[si + 1], 'read-only');
  assert.equal(cap.args[cap.args.length - 1], '-', 'промпт читается из stdin');
  assert.match(cap.stdin, /SYS\n\nUSR/, 'system+user склеены и поданы в stdin');
});

test('codexAgent: bypassSandbox=true → --dangerously-bypass-... вместо -s', async () => {
  const cap = {};
  const run = makeCodexRunAgent({ spawn: fakeSpawn(cap), bypassSandbox: true, sandbox: 'read-only', log: { warn() {} } });
  await run(task, {});
  assert.ok(cap.args.includes('--dangerously-bypass-approvals-and-sandbox'), 'передан флаг обхода песочницы');
  assert.ok(!cap.args.includes('-s'), 'при bypass -s взаимоисключается и не передаётся');
});

test('codexAgent: модель добавляется только если задана', async () => {
  const cap1 = {};
  await makeCodexRunAgent({ spawn: fakeSpawn(cap1), model: '', log: { warn() {} } })(task, {});
  assert.ok(!cap1.args.includes('-m'), 'без модели нет -m (codex берёт дефолт из config)');
  const cap2 = {};
  await makeCodexRunAgent({ spawn: fakeSpawn(cap2), model: 'gpt-5-codex', log: { warn() {} } })(task, {});
  const mi = cap2.args.indexOf('-m');
  assert.equal(cap2.args[mi + 1], 'gpt-5-codex');
});

test('codexAgent: codex упал и нет вывода → ok:false', async () => {
  const cap = {};
  const run = makeCodexRunAgent({ spawn: fakeSpawn(cap, { code: 1 }), log: { warn() {} } });
  const out = await run(task, {});
  assert.equal(out.ok, false);
});

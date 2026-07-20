// PROGRAMMER-SELF-CHECK-001 — тесты петли самопроверки.
// Команды берём кроссплатформенные (`node -e ...`), чтобы тест не зависел от
// оболочки: раннер живёт на Windows, CI может быть другим.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  detectStack, detectVerifyCommands, resolveVerifyDir, runVerify, runVerifyCommand, tailOutput,
} from '../src/selfCheck.js';

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'selfcheck-'));
}

test('detectStack: go.mod → go, package.json со скриптом test → node, иначе null', () => {
  const dir = tmpDir();
  try {
    assert.equal(detectStack(dir), null);

    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }));
    assert.equal(detectStack(dir), null, 'package.json без test-скрипта тестами не считается');

    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    assert.equal(detectStack(dir), 'node');

    writeFileSync(path.join(dir, 'go.mod'), 'module x\n');
    assert.equal(detectStack(dir), 'go', 'go.mod приоритетнее package.json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectVerifyCommands: автодетект и явный override через env', () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(detectVerifyCommands(dir, { envOverride: '' }), []);

    writeFileSync(path.join(dir, 'go.mod'), 'module x\n');
    assert.deepEqual(detectVerifyCommands(dir, { envOverride: '' }), ['go test ./...']);

    // override перекрывает автодетект и разбивается по &&
    assert.deepEqual(
      detectVerifyCommands(dir, { envOverride: 'npm run lint && npm test ' }),
      ['npm run lint', 'npm test'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveVerifyDir: каталог сервиса выбирается, только если в нём есть что проверять', () => {
  const root = tmpDir();
  try {
    const svc = path.join(root, 'Chat_Service');
    mkdirSync(svc);
    assert.equal(resolveVerifyDir(root, { service: 'Chat_Service' }), root,
      'пустой каталог сервиса — проверяем корень worktree');

    writeFileSync(path.join(svc, 'go.mod'), 'module chat\n');
    assert.equal(resolveVerifyDir(root, { service: 'Chat_Service' }), svc);

    assert.equal(resolveVerifyDir(root, { service: 'Missing' }), root);
    assert.equal(resolveVerifyDir(root, {}), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runVerifyCommand: нулевой код — успех, ненулевой — провал с выводом', async () => {
  const okRes = await runVerifyCommand('node -e "process.exit(0)"', { cwd: process.cwd() });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.exitCode, 0);

  const badRes = await runVerifyCommand(
    'node -e "console.error(\'boom-marker\'); process.exit(3)"',
    { cwd: process.cwd() },
  );
  assert.equal(badRes.ok, false);
  assert.equal(badRes.exitCode, 3);
  assert.match(badRes.output, /boom-marker/, 'вывод упавшей команды нужен агенту для ремонта');
});

test('runVerifyCommand: таймаут не вешает раннер и помечается timedOut', async () => {
  const res = await runVerifyCommand('node -e "setTimeout(()=>{}, 10000)"', {
    cwd: process.cwd(),
    timeoutMs: 300,
  });
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
});

test('runVerifyCommand: внешний abort обрывает проверку', async () => {
  const ac = new AbortController();
  const p = runVerifyCommand('node -e "setTimeout(()=>{}, 10000)"', {
    cwd: process.cwd(),
    signal: ac.signal,
  });
  setTimeout(() => ac.abort(), 100);
  const res = await p;
  assert.equal(res.ok, false);
  assert.equal(res.aborted, true);
});

test('runVerify: пустой список команд — проверка пропущена, а не «пройдена»', async () => {
  const res = await runVerify({ commands: [], cwd: process.cwd() });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
});

test('runVerify: останавливается на первой упавшей команде', async () => {
  const res = await runVerify({
    commands: [
      'node -e "process.exit(0)"',
      'node -e "process.exit(1)"',
      'node -e "process.exit(0)"',
    ],
    cwd: process.cwd(),
  });
  assert.equal(res.ok, false);
  assert.equal(res.ran.length, 2, 'третья команда не запускается — чинить всё равно вторую');
  assert.equal(res.failure.exitCode, 1);
});

test('runVerify: все зелёные — ok', async () => {
  const res = await runVerify({
    commands: ['node -e "process.exit(0)"', 'node -e "process.exit(0)"'],
    cwd: process.cwd(),
  });
  assert.equal(res.ok, true);
  assert.equal(res.ran.length, 2);
});

test('tailOutput: длинный вывод обрезается с конца', () => {
  const short = 'abc';
  assert.equal(tailOutput(short, 10), 'abc');

  const long = 'x'.repeat(50) + 'THE-END';
  const cut = tailOutput(long, 10);
  assert.match(cut, /THE-END$/, 'хвост сохраняется — там и лежит ошибка');
  assert.match(cut, /обрезано/);
});

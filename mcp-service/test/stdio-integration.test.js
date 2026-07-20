// MCP-TOKEN-SYNC-001 — интеграционный тест: orchestrator_create_task через
// РЕАЛЬНЫЙ stdio-запуск (spawn bin/mcp-service.js) + фейковый orchestrator,
// требующий Bearer-токен. Воспроизводит сценарий Codex: в окружении процесса
// НЕТ ORCHESTRATOR_API_TOKEN, но он есть в репозиторном .env (единый источник) —
// и мутация авторизуется без 401.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mcp-service.js');
let tmpCounter = 0;

/** Фейковый orchestrator: /api/scanner/task-intake требует Bearer <token> (иначе 401). */
function makeFakeOrchestrator({ token }) {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const auth = String(req.headers.authorization || '');
      if (token && auth !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorized', code: 'unauthorized' }));
      }
      if (req.method === 'POST' && req.url === '/api/scanner/task-intake') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, taskId: 'T-1', duplicate: false }));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
  });
  return srv;
}

/** Минимальный MCP-клиент поверх stdio (newline-delimited JSON-RPC). */
function attachStdioClient(child) {
  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: res, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        res(msg);
      }
    }
  });
  function send(msg) {
    child.stdin.write(JSON.stringify(msg) + '\n');
  }
  function request(msg, timeoutMs = 8000) {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pending.delete(msg.id);
        rej(new Error(`таймаут ответа на id=${msg.id}`));
      }, timeoutMs);
      pending.set(msg.id, { resolve: res, timer });
      send(msg);
    });
  }
  return { send, request };
}

/** Дождаться готовности stdio по строке в stderr. */
function waitReady(child, getStderr, timeoutMs = 10000) {
  return new Promise((res, rej) => {
    if (/stdio готов/.test(getStderr())) return res();
    const timer = setTimeout(() => {
      child.stderr.off('data', onData);
      rej(new Error(`нет готовности stdio; stderr=\n${getStderr()}`));
    }, timeoutMs);
    function onData() {
      if (/stdio готов/.test(getStderr())) {
        clearTimeout(timer);
        child.stderr.off('data', onData);
        res();
      }
    }
    child.stderr.on('data', onData);
  });
}

async function runStdioCreateTask({ token, envFileContent }) {
  const orch = makeFakeOrchestrator({ token });
  await new Promise((r) => orch.listen(0, '127.0.0.1', r));
  const orchUrl = `http://127.0.0.1:${orch.address().port}`;

  const envFile = join(tmpdir(), `mcp-itest-${process.pid}-${tmpCounter++}.env`);
  writeFileSync(envFile, envFileContent, 'utf8');

  // Окружение процесса НАМЕРЕННО без ORCHESTRATOR_API_TOKEN (сценарий Codex).
  const childEnv = { ...process.env };
  delete childEnv.ORCHESTRATOR_API_TOKEN;
  delete childEnv.MCP_HTTP;
  childEnv.PROJECT_ROOT = '/x';
  childEnv.ORCHESTRATOR_URL = orchUrl;
  childEnv.TOOLS_SERVICE_URL = 'http://127.0.0.1:1';
  childEnv.MCP_ENABLE_ORCHESTRATOR_MUTATIONS = '1';
  childEnv.MCP_ENV_FILE = envFile;

  const child = spawn(process.execPath, [BIN], {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c.toString('utf8')));

  try {
    await waitReady(child, () => stderr);
    const client = attachStdioClient(child);

    const init = await client.request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'itest', version: '1.0' },
      },
    });
    assert.ok(init.result, `initialize вернул result: ${JSON.stringify(init)}`);
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const call = await client.request({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'orchestrator_create_task',
        arguments: {
          externalId: 'itest-1',
          projectPath: '/x',
          title: 'Integration test task',
          description: 'stdio integration',
          // TASK-ACCEPTANCE-CRITERIA-001 — поле обязательное, SDK валидирует схему
          // на реальном stdio-вызове (в отличие от юнит-тестов с фейковым реестром).
          acceptanceCriteria: ['tools/call возвращает taskId без 401'],
        },
      },
    });
    assert.ok(call.result, `tools/call вернул result: ${JSON.stringify(call)}`);
    const text = call.result.content?.[0]?.text || '';
    return { result: call.result, text, stderr };
  } finally {
    child.kill();
    await new Promise((r) => orch.close(r));
    try {
      unlinkSync(envFile);
    } catch {
      /* временный файл мог не создаться — не критично */
    }
  }
}

test('stdio: orchestrator_create_task авторизуется токеном из .env — без 401', async () => {
  const token = 'itest-token-ok';
  const { result, text } = await runStdioCreateTask({
    token,
    envFileContent: `ORCHESTRATOR_API_TOKEN=${token}\n`,
  });
  assert.equal(result.isError, undefined, `create_task не должен быть ошибкой: ${text}`);
  assert.ok(!/401/.test(text), `в ответе не должно быть 401: ${text}`);
  const payload = JSON.parse(text);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, 200);
  assert.equal(payload.data.taskId, 'T-1');
});

test('stdio: без токена (ни в env, ни в .env) create_task получает 401 — авторизация реально требуется', async () => {
  const { result, text } = await runStdioCreateTask({
    token: 'server-requires-this',
    envFileContent: '# .env без ORCHESTRATOR_API_TOKEN\n',
  });
  assert.equal(result.isError, true, `ожидали ошибку авторизации: ${text}`);
  const payload = JSON.parse(text);
  assert.equal(payload.status, 401);
});

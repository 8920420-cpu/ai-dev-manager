#!/usr/bin/env node
// Нативный host-runner: опрашивает оркестратор и выполняет роли действия
// (PIPELINE_SERVICE/GIT_INTEGRATOR) на хосте, где есть docker/git/репозиторий.
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { HostRunner } from '../src/HostRunner.js';
import { runPipelineAction, runGitAction } from '../src/actions.js';
import { pickFolder } from '../src/folderPicker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ORCH = (process.env.ORCHESTRATOR_URL || 'http://localhost:4186').replace(/\/+$/, '');
const TOKEN = process.env.ORCHESTRATOR_API_TOKEN || '';
const INTERVAL_MS = Number(process.env.HOST_RUNNER_INTERVAL_MS || 3000);
// Корень репозитория: по умолчанию на два уровня выше bin/ (host-runner/..).
const REPO_ROOT = process.env.HOST_REPO_ROOT || path.resolve(__dirname, '../..');
// Локальный HTTP-мост для нативных host-операций из UI (выбор папки и т.п.).
// Браузер открыт на той же машине → достучится по localhost. 0 = выключить.
const PICKER_PORT = Number(process.env.HOST_PICKER_PORT || 4187);

function headers(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

const http = {
  async claim(role) {
    const res = await fetch(`${ORCH}/api/runner/next-host-task?role=${encodeURIComponent(role)}`, { headers: headers() });
    if (!res.ok) throw new Error(`claim ${role}: HTTP ${res.status}`);
    return res.json();
  },
  async complete(body) {
    const res = await fetch(`${ORCH}/api/runner/host-task-completed`, {
      method: 'POST', headers: headers(), body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`complete: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    return res.json();
  },
  async release(taskId) {
    const res = await fetch(`${ORCH}/api/runner/release-host-task`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ taskId }),
    });
    if (!res.ok) throw new Error(`release: HTTP ${res.status}`);
    return res.json();
  },
};

const executors = {
  PIPELINE_SERVICE: (task) => runPipelineAction(task, { repoRoot: REPO_ROOT }),
  GIT_INTEGRATOR: (task) => runGitAction(task, { repoRoot: REPO_ROOT }),
};

const runner = new HostRunner({ http, executors });

// --- Локальный HTTP-мост: нативный диалог выбора папки для UI ---
// Только localhost; CORS открыт, т.к. UI отдаётся с другого порта (orchestrator).
function startPickerServer() {
  if (!PICKER_PORT) return;
  const cors = (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  };
  const srv = createServer(async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', service: 'host-runner-picker' }));
    }
    if (req.method === 'POST' && url.pathname === '/pick-folder') {
      try {
        const result = await pickFolder();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      } catch (e) {
        const code = e.code === 'unsupported_platform' ? 501 : 500;
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: e.message, code: e.code }));
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  srv.on('error', (e) => console.error(`host-runner picker server error: ${e.message}`));
  srv.listen(PICKER_PORT, '127.0.0.1', () =>
    console.log(`host-runner: picker bridge on http://127.0.0.1:${PICKER_PORT}/pick-folder`),
  );
  return srv;
}

const pickerServer = startPickerServer();

console.log(`host-runner: orchestrator=${ORCH} repo=${REPO_ROOT} interval=${INTERVAL_MS}ms`);
console.log('host-runner: roles PIPELINE_SERVICE, GIT_INTEGRATOR');

let stopping = false;
async function loop() {
  while (!stopping) {
    try {
      const out = await runner.tick();
      const acted = out.filter((o) => o && o.taskId);
      if (acted.length) console.log('host-runner tick:', JSON.stringify(acted));
    } catch (e) {
      console.error('host-runner tick error:', e.message);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopping = true; pickerServer?.close(); setTimeout(() => process.exit(0), 200); });
}

loop();

#!/usr/bin/env node
// Нативный host-runner: опрашивает оркестратор и выполняет роли действия
// (PIPELINE_SERVICE/GIT_INTEGRATOR) на хосте, где есть docker/git/репозиторий.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostRunner } from '../src/HostRunner.js';
import { runPipelineAction, runGitAction } from '../src/actions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ORCH = (process.env.ORCHESTRATOR_URL || 'http://localhost:4186').replace(/\/+$/, '');
const TOKEN = process.env.ORCHESTRATOR_API_TOKEN || '';
const INTERVAL_MS = Number(process.env.HOST_RUNNER_INTERVAL_MS || 3000);
// Корень репозитория: по умолчанию на два уровня выше bin/ (host-runner/..).
const REPO_ROOT = process.env.HOST_REPO_ROOT || path.resolve(__dirname, '../..');

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
  process.on(sig, () => { stopping = true; setTimeout(() => process.exit(0), 200); });
}

loop();

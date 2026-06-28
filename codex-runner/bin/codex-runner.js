#!/usr/bin/env node
// CODEX-REASONING-001 — автоматический исполнитель рассуждающих ролей (Приёмщик/
// Архитектор/Декомпозитор и пр.), делегированных Codex: опрашивает оркестратор,
// запускает headless `codex exec` на готовом промпте роли в корне проекта и сдаёт
// вердикт. Какие именно роли идут через Codex, решает оркестратор (настройка
// «codexReasoningRoles»); этот раннер берёт любую делегированную задачу.
//
// Авторизация: Codex берёт подписку ChatGPT из ~/.codex/auth.json (CODEX_HOME) сам —
// предварительно выполните `codex login` на этой машине.
import { ReasoningRunner } from '../src/ReasoningRunner.js';
import { makeCodexRunAgent } from '../src/codexAgent.js';

const ORCH = (process.env.ORCHESTRATOR_URL || 'http://localhost:4186').replace(/\/+$/, '');
const TOKEN = process.env.ORCHESTRATOR_API_TOKEN || '';
const INTERVAL_MS = Number(process.env.CODEX_INTERVAL_MS || 5000);
// Жёсткий таймаут на задачу. Держим меньше орфан-таймаута оркестратора
// (RUNNER_ROLE_TIMEOUT_MS≈15 мин), чтобы освобождать захват раньше реапера.
const TASK_TIMEOUT_MS = Number(process.env.CODEX_TASK_TIMEOUT_MS || 10 * 60 * 1000);
// Потолок параллелизма: рассуждающие прогоны лёгкие, но Codex-сессии длинные —
// держим скромно. Можно поднять CODEX_CONCURRENCY.
const CONCURRENCY = Math.max(1, Number(process.env.CODEX_CONCURRENCY || 2));
// Если задан CODEX_ROLE — раннер опрашивает только эту роль (полезно разнести
// воркеры по ролям); иначе берёт любую делегированную Codex задачу.
const ROLE = String(process.env.CODEX_ROLE || '').trim();

function headers(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

async function asJson(res, label) {
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

const http = {
  // GET /api/runner/next-reasoning-task?engine=codex[&role=] → { task } | { task:null } | { blocked }.
  async claim() {
    const params = new URLSearchParams({ engine: 'codex' });
    if (ROLE) params.set('role', ROLE);
    const res = await fetch(`${ORCH}/api/runner/next-reasoning-task?${params}`, { headers: headers() });
    return asJson(res, 'claim');
  },
  async complete(body) {
    const res = await fetch(`${ORCH}/api/runner/reasoning-completed`, {
      method: 'POST', headers: headers(), body: JSON.stringify(body),
    });
    return asJson(res, 'complete');
  },
  async release(taskId) {
    const res = await fetch(`${ORCH}/api/runner/release-reasoning-task`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ taskId }),
    });
    return asJson(res, 'release');
  },
};

const runAgent = makeCodexRunAgent();
const runner = new ReasoningRunner({ http, runAgent, taskTimeoutMs: TASK_TIMEOUT_MS, concurrency: CONCURRENCY });

console.log(`codex-runner: orchestrator=${ORCH} interval=${INTERVAL_MS}ms taskTimeout=${TASK_TIMEOUT_MS}ms`);
console.log(`codex-runner: рассуждающие роли через Codex, concurrency=${CONCURRENCY}, role=${ROLE || 'любая делегированная'}`);

let stopping = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function worker(id) {
  while (!stopping) {
    let out;
    try {
      out = await runner.tick();
    } catch (e) {
      console.error(`codex-runner[${id}] tick error:`, e.message);
      await sleep(INTERVAL_MS);
      continue;
    }
    if (out && (out.taskId || out.blocked)) console.log(`codex-runner[${id}] tick:`, JSON.stringify(out));
    // released — задача вернулась в пул (codex упал/таймаут/сбой бэкенда). БЕЗ паузы
    // воркер тут же заклеймит ту же задачу снова → горячий спин claim→fail→release
    // (сотни CANCELLED/час при недоступном Codex). Бэкофф на INTERVAL_MS.
    if (!out || out.idle || out.busy || out.error || out.released) await sleep(INTERVAL_MS);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopping = true; setTimeout(() => process.exit(0), 200); });
}

Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));

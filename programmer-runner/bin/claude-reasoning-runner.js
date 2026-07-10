#!/usr/bin/env node
// ROLE-ENGINE-ROUTING-001 — драйвер РАССУЖДАЮЩИХ ролей через Claude Code (Agent
// SDK), назначенных движку 'claude_code'. Опрашивает generic-мост оркестратора,
// получает роль+готовый промпт+контекст, гоняет headless Claude в корне проекта и
// сдаёт вердикт. Драйвер «тупой»: какие роли идёт через Claude — решает оркестратор
// (настройка roleEngines), сам раннер не знает, что будет делать.
//
// Авторизация Agent SDK — та же, что у programmer-runner: ANTHROPIC_API_KEY /
// CLAUDE_CODE_OAUTH_TOKEN / файл токена (ensureClaudeToken) / залогиненная подписка.
import { ReasoningRunner } from '../src/ReasoningRunner.js';
import { makeClaudeReasoningRunAgent } from '../src/claudeReasoningAgent.js';
import { ensureClaudeToken } from '../src/loadToken.js';
import { resolveDuration, resolveInt, logEffectiveConfig } from '../src/envConfig.js';
import { beat } from '../../shared/heartbeat.js';

const ORCH = (process.env.ORCHESTRATOR_URL || 'http://localhost:4186').replace(/\/+$/, '');
const TOKEN = process.env.ORCHESTRATOR_API_TOKEN || '';
// CONFIG-AUDIT-001: единый разбор числовых env (единицы, диапазон, источник).
// КОНТРАКТ: TASK_TIMEOUT < орфан-таймаута оркестратора (RUNNER_ROLE_TIMEOUT_MS,
// дефолт 10 мин) — иначе реапер освободит захват раньше раннера и прогон сдастся
// «вхолостую» (agent_aborted по кругу). start-runners.ps1 ставит 540000 (9 мин).
// effectiveConfig в логе показывает source/raw — видно, если значение пришло из
// унаследованного окружения, а не из дефолта (см. CONFIG_AUDIT.md).
const intervalCfg = resolveDuration('CLAUDE_REASONING_INTERVAL_MS', 5000, { min: 200, max: 5 * 60_000 });
const taskTimeoutCfg = resolveDuration('CLAUDE_REASONING_TASK_TIMEOUT_MS', 10 * 60_000, { min: 30_000, max: 60 * 60_000 });
// ROLE-TIMEOUT-001: персональный бюджет Архитектора. Пакетный эпик (4–5 сервисов с
// пофайловыми work_items) не укладывается в общие 9 мин — прогон обрывался на
// середине и перезапускался по кругу. КОНТРАКТ: < RUNNER_ROLE_TIMEOUT_MS (орфан).
const architectTimeoutCfg = resolveDuration('ARCHITECT_TASK_TIMEOUT_MS', 20 * 60_000, { min: 30_000, max: 60 * 60_000 });
const concurrencyCfg = resolveInt('CLAUDE_REASONING_CONCURRENCY', 2, { min: 1, max: 8 });
// PROVIDER-LIMIT-COOLDOWN-002: пауза при превышении лимита подписки Claude/квоты/
// перегрузке (дефолт 1 час — настройка). По истечении раннер сначала ПРОВЕРЯЕТ движок
// (probe) и только при успехе снова берёт задачи (см. ReasoningRunner).
const providerCooldownCfg = resolveDuration('CLAUDE_REASONING_PROVIDER_COOLDOWN_MS', 60 * 60_000, { min: 60_000, max: 6 * 60 * 60_000 });
logEffectiveConfig('claude-reasoning-runner', [intervalCfg, taskTimeoutCfg, architectTimeoutCfg, concurrencyCfg, providerCooldownCfg]);
const INTERVAL_MS = intervalCfg.value;
const TASK_TIMEOUT_MS = taskTimeoutCfg.value;
const ARCHITECT_TIMEOUT_MS = architectTimeoutCfg.value;
const CONCURRENCY = concurrencyCfg.value;
const PROVIDER_COOLDOWN_MS = providerCooldownCfg.value;
// Если задан CLAUDE_REASONING_ROLE — опрашиваем только её, иначе любую роль,
// назначенную движку claude_code.
const ROLE = String(process.env.CLAUDE_REASONING_ROLE || '').trim();

const tokenLoad = ensureClaudeToken();
if (tokenLoad.loaded) {
  console.log('claude-reasoning-runner: токен подписки подхвачен из файла (CLAUDE_CODE_OAUTH_TOKEN)');
} else if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.log('claude-reasoning-runner: ключ/токен не заданы — рассчитываю на залогиненную подписку Claude Code');
}

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
  // GET /api/runner/next-reasoning-task?engine=claude_code[&role=].
  async claim() {
    const params = new URLSearchParams({ engine: 'claude_code' });
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

const runAgent = makeClaudeReasoningRunAgent();
const runner = new ReasoningRunner({
  http, runAgent, taskTimeoutMs: TASK_TIMEOUT_MS, concurrency: CONCURRENCY, providerCooldownMs: PROVIDER_COOLDOWN_MS,
  // ROLE-TIMEOUT-001: Архитектору — расширенный бюджет прогона (см. контракт выше).
  roleTimeoutsMs: { ARCHITECT: ARCHITECT_TIMEOUT_MS },
});

console.log(`claude-reasoning-runner: orchestrator=${ORCH}, рассуждающие роли через Claude Code, role=${ROLE || 'любая делегированная'}`);

let stopping = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function worker(id) {
  while (!stopping) {
    beat(); // RUNNER-HEARTBEAT-001: отметка живости для вотчдога свежести
    let out;
    try {
      out = await runner.tick();
    } catch (e) {
      console.error(`claude-reasoning-runner[${id}] tick error:`, e.message);
      await sleep(INTERVAL_MS);
      continue;
    }
    if (out && (out.taskId || out.blocked)) console.log(`claude-reasoning-runner[${id}] tick:`, JSON.stringify(out));
    // released — задача вернулась в пул (агент упал/таймаут). БЕЗ паузы воркер тут же
    // заклеймит её снова → горячий спин claim→fail→release. Бэкофф на INTERVAL_MS.
    // PROVIDER-LIMIT-COOLDOWN-002: cooldown — пауза по лимиту подписки; probe — тик
    // только проверил движок (реальную задачу не брал). Оба холостые — ждём INTERVAL.
    if (!out || out.idle || out.busy || out.error || out.released || out.cooldown || out.probe) await sleep(INTERVAL_MS);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopping = true; setTimeout(() => process.exit(0), 200); });
}

Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));

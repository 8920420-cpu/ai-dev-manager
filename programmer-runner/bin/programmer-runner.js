#!/usr/bin/env node
// Автоматический исполнитель роли PROGRAMMER (стадия CODING): опрашивает
// оркестратор, запускает headless Claude Code (Agent SDK) на задаче в рабочем
// дереве проекта и сдаёт результат. Без него CODING двигается только живой
// Claude-сессией — отсюда массовый затор задач в RESTART.
import { ProgrammerRunner } from '../src/ProgrammerRunner.js';
import { makeClaudeRunAgent } from '../src/claudeAgent.js';
import { ensureClaudeToken } from '../src/loadToken.js';
import { resolveDuration, logEffectiveConfig } from '../src/envConfig.js';
import { beat } from '../../shared/heartbeat.js';

const ORCH = (process.env.ORCHESTRATOR_URL || 'http://localhost:4186').replace(/\/+$/, '');
const TOKEN = process.env.ORCHESTRATOR_API_TOKEN || '';
// CONFIG-AUDIT-001: единый разбор числовых env (единицы, диапазон, источник).
// КОНТРАКТ: TASK_TIMEOUT < орфан-таймаута программиста оркестратора
// (RUNNER_CLAUDE_TIMEOUT_MS, .env=1500000≈25 мин), чтобы освобождать захват раньше
// реапера. effectiveConfig в логе показывает source/raw (см. CONFIG_AUDIT.md).
const intervalCfg = resolveDuration('PROGRAMMER_INTERVAL_MS', 5000, { min: 200, max: 5 * 60_000 });
const taskTimeoutCfg = resolveDuration('PROGRAMMER_TASK_TIMEOUT_MS', 20 * 60_000, { min: 60_000, max: 60 * 60_000 });
const settingsPollCfg = resolveDuration('PROGRAMMER_SETTINGS_POLL_MS', 15000, { min: 1000, max: 5 * 60_000 });
const providerCooldownCfg = resolveDuration('PROGRAMMER_PROVIDER_COOLDOWN_MS', 60 * 60_000, { min: 60_000, max: 6 * 60 * 60_000 });
const INTERVAL_MS = intervalCfg.value;
const TASK_TIMEOUT_MS = taskTimeoutCfg.value;
const SETTINGS_POLL_MS = settingsPollCfg.value;
const PROVIDER_COOLDOWN_MS = providerCooldownCfg.value;
// PROGRAMMER-PRIORITY-001: решение отменено. Жёсткий потолок worktree-параллелизма
// программиста — 3 одновременно работающих агента по РАЗНЫМ сервисам (изначальный
// cap по PROGRAMMER-WORKTREE-PER-SERVICE). Совпадает с границами настройки
// programmer_concurrency (appSettings.js, max=3), так что refreshConcurrency ниже
// клампит значение из настроек в [1..MAX_CONCURRENCY]. Сериализация «один активный
// CODING на сервис» (оркестратор) + worktree-изоляция по сервису гарантируют, что
// 3 агента идут по разным сервисам без конфликтов в общем дереве.
const MAX_CONCURRENCY = 3;
const clampConc = (n) => Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(Number(n) || 1)));
const START_CONCURRENCY = clampConc(process.env.PROGRAMMER_CONCURRENCY || MAX_CONCURRENCY);
logEffectiveConfig('programmer-runner', [intervalCfg, taskTimeoutCfg, settingsPollCfg, providerCooldownCfg]);

// Авторизация Agent SDK. Возможны варианты:
//   1) ANTHROPIC_API_KEY — обычный API-ключ (перебивает подписку);
//   2) CLAUDE_CODE_OAUTH_TOKEN — токен подписки (`claude setup-token`);
//   3) файл токена от кнопки в настройках (host-runner мост) → ensureClaudeToken
//      подхватит его в CLAUDE_CODE_OAUTH_TOKEN;
//   4) залогиненная подписка Claude Code на машине.
const tokenLoad = ensureClaudeToken();
if (tokenLoad.loaded) {
  console.log('programmer-runner: токен подписки подхвачен из файла (CLAUDE_CODE_OAUTH_TOKEN)');
} else if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.log('programmer-runner: ключ/токен не заданы и файла токена нет —'
    + ' рассчитываю на залогиненную подписку Claude Code на этой машине');
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
  // GET /api/runner/next-claude-task → { ok, status, data:{ task } }. Возвращаем
  // data, чтобы ProgrammerRunner читал .task.
  async claim() {
    const res = await fetch(`${ORCH}/api/runner/next-claude-task`, { headers: headers() });
    const json = await asJson(res, 'claim');
    return json.data ?? json;
  },
  async complete(body) {
    const res = await fetch(`${ORCH}/api/scanner/task-completed`, {
      method: 'POST', headers: headers(), body: JSON.stringify(body),
    });
    const json = await asJson(res, 'complete');
    return json.data ?? json;
  },
  // opts: { reason, meta } — при упоре в лимит ходов оркестратор по reason
  // записывает событие KPI (см. releaseClaudeTask).
  async release(taskId, opts = {}) {
    const res = await fetch(`${ORCH}/api/runner/release-claude-task`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ taskId, reason: opts.reason, meta: opts.meta }),
    });
    return asJson(res, 'release');
  },
  // TASK-NEEDS-INPUT-001: припарковать задачу на вопросе к человеку (NEEDS_INPUT).
  // input: { question, options?, context? } — роль подставляем здесь, раннер знает
  // её сам и агенту незачем её сочинять.
  async needsInput(taskId, input = {}) {
    const res = await fetch(`${ORCH}/api/runner/needs-input`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        taskId,
        question: input.question,
        options: input.options,
        context: input.context,
        roleCode: 'PROGRAMMER',
      }),
    });
    const json = await asJson(res, 'needs-input');
    return json.data ?? json;
  },
  // Настройка параллельности программиста из app-settings (Настройки → Выполнение).
  async programmerConcurrency() {
    const res = await fetch(`${ORCH}/api/app-settings`, { headers: headers() });
    const json = await asJson(res, 'app-settings');
    const data = json.data ?? json;
    return data?.programmerConcurrency;
  },
};

// Изоляция через worktree СВОЕГО микросервиса — единственный режим: безопасна при
// параллелизме и точно атрибутирует changedFiles (дельта worktree, а не снимок дерева).
const runAgent = makeClaudeRunAgent();
// Стартуем со стартовым значением; фактическое тянем из настроек ниже.
const runner = new ProgrammerRunner({
  http, runAgent, taskTimeoutMs: TASK_TIMEOUT_MS, concurrency: START_CONCURRENCY,
  providerCooldownMs: PROVIDER_COOLDOWN_MS,
});

console.log(`programmer-runner: orchestrator=${ORCH}, роль PROGRAMMER (стадия CODING), maxConcurrency=${MAX_CONCURRENCY}, start=${START_CONCURRENCY}`);

let stopping = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Подтянуть параллельность из настроек и применить к runner (на лету, без
// перезапуска). Значение клампится в [1..MAX_CONCURRENCY] — потолок жёсткий.
async function refreshConcurrency() {
  try {
    const raw = await http.programmerConcurrency();
    if (raw === undefined || raw === null) return;
    const next = clampConc(raw);
    if (next !== runner.concurrency) {
      console.log(`programmer-runner: concurrency ${runner.concurrency} → ${next} (из настроек)`);
      runner.concurrency = next;
    }
  } catch (e) {
    console.error('programmer-runner: не удалось прочитать настройку параллельности:', e.message);
  }
}

// Один воркер: захватывает и обрабатывает задачи по одной. Пустой захват/занятые
// слоты → пауза, иначе сразу берём следующую. Всегда поднимаем MAX_CONCURRENCY
// воркеров; реальный параллелизм ограничивает in-flight гард tick() по
// runner.concurrency (значение из настроек). Захваты безопасны параллельно:
// claim берёт строку FOR UPDATE SKIP LOCKED, двойной выдачи не будет.
async function worker(id) {
  while (!stopping) {
    beat(); // RUNNER-HEARTBEAT-001: отметка живости для вотчдога свежести
    let out;
    try {
      out = await runner.tick();
    } catch (e) {
      console.error(`programmer-runner[${id}] tick error:`, e.message);
      await sleep(INTERVAL_MS);
      continue;
    }
    if (out && out.taskId) console.log(`programmer-runner[${id}] tick:`, JSON.stringify(out));
    if (out?.cooldown && id === 1) {
      console.log(`programmer-runner: provider cooldown until ${new Date(out.until).toISOString()}`);
    }
    if (!out || out.idle || out.busy || out.cooldown) await sleep(INTERVAL_MS);
  }
}

async function settingsLoop() {
  while (!stopping) {
    await refreshConcurrency();
    await sleep(SETTINGS_POLL_MS);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopping = true; setTimeout(() => process.exit(0), 200); });
}

await refreshConcurrency(); // первичная синхронизация до старта воркеров
settingsLoop();
Promise.all(Array.from({ length: MAX_CONCURRENCY }, (_, i) => worker(i + 1)));

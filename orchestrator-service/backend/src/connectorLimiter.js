// CONNECTOR-LIMITER-001 — глобальный адаптивный лимитер вызовов внешнего LLM
// (DeepSeek/OpenAI-совместимые). Единый регулятор на ВЕСЬ процесс оркестратора:
//
//  1) Ограничивает число одновременных HTTP-запросов к модели (семафор) — чтобы
//     не «долбить» провайдера десятками параллельных вызовов на роль.
//  2) Сам нащупывает потолок (AIMD): при устойчивом успехе ПОД НАГРУЗКОЙ
//     поднимает лимит на +1, при троттлинге/ошибке откатывается (÷2) и пишет в
//     лог, на каком пределе сломалось.
//  3) Ведёт учёт токенов (скользящее окно TPM) — троттлинг DeepSeek часто идёт
//     по токенам в минуту, а не по числу запросов, и отслеживать удобнее по ним.
//  4) Отдаёт «есть ли свободный слот» (stats/canSend) — чтобы сервисы спрашивали
//     ёмкость и ждали, а не слали запросы вхолостую.
//
// Чистые функции решения (classifyOutcome/nextLimit*) экспортируются для тестов.

function envInt(name, def) {
  const n = Number.parseInt(String(process.env[name] ?? '').trim(), 10);
  return Number.isFinite(n) ? n : def;
}

const START = Math.max(1, envInt('CONNECTOR_LIMIT_START', 6));
const MIN = Math.max(1, envInt('CONNECTOR_LIMIT_MIN', 2));
const MAX = Math.max(MIN, envInt('CONNECTOR_LIMIT_MAX', 32));
// Сколько успехов подряд под насыщением до пробного +1.
const PROBE_AFTER = Math.max(1, envInt('CONNECTOR_LIMIT_PROBE_AFTER', 15));
// Окно учёта токенов (мс) и опциональный бюджет TPM (0 = выключено).
const TOKEN_WINDOW_MS = Math.max(1000, envInt('CONNECTOR_TOKEN_WINDOW_MS', 60_000));
const TPM_BUDGET = Math.max(0, envInt('CONNECTOR_TPM_BUDGET', 0));

const log = (msg) => console.log(`[connector-limiter] ${msg}`);

// --- чистые функции решения (юнит-тестируемы) ------------------------------

// Классификация исхода вызова: 'ok' | 'throttle' | 'error'.
// throttle = сигнал «провайдер перегружен / лимит»: 429, 5xx, таймаут/abort,
// сетевой сбой, либо тело/сообщение с признаками rate-limit/перегруза/токенов.
export function classifyOutcome({ httpStatus = 0, errorMessage = '', aborted = false } = {}) {
  if (aborted) return 'throttle';
  if (httpStatus === 429) return 'throttle';
  if (httpStatus >= 500 && httpStatus <= 599) return 'throttle';
  const m = String(errorMessage || '').toLowerCase();
  if (m && /(rate.?limit|too many|quota|overload|capacity|server busy|tpm|token.?limit|503|429|econn|etimedout|socket hang|network|fetch failed|aborted)/.test(m)) {
    return 'throttle';
  }
  if (httpStatus >= 400 && httpStatus <= 499) return 'error'; // клиентская ошибка — не троттлинг
  if (httpStatus >= 200 && httpStatus <= 299) return 'ok';
  if (m) return 'error';
  return 'ok';
}

export function nextLimitOnThrottle(limit, min = MIN) {
  return Math.max(min, Math.floor(limit / 2));
}
export function nextLimitOnSuccess(limit, max = MAX) {
  return Math.min(max, limit + 1);
}

// --- состояние синглтона ----------------------------------------------------

const state = {
  limit: Math.min(MAX, Math.max(MIN, START)),
  active: 0,
  queue: [],
  successStreak: 0,
  sawSaturation: false, // был ли отказ в слоте с прошлого изменения лимита
  tokenWindow: [], // [ [tsMs, totalTokens], ... ]
  lastThrottleAt: null,
  lastChangeAt: null,
  lastChangeReason: null,
};

function pump() {
  while (state.queue.length && state.active < state.limit) {
    const grant = state.queue.shift();
    grant();
  }
}

// Захватить слот. Возвращает одноразовую release-функцию. Если свободных слотов
// нет — ждём в FIFO-очереди (и фиксируем насыщение для AIMD-пробы вверх).
export async function acquire() {
  await new Promise((resolve) => {
    if (state.active < state.limit) {
      state.active += 1;
      resolve();
    } else {
      state.sawSaturation = true;
      state.queue.push(() => {
        state.active += 1;
        resolve();
      });
    }
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.active = Math.max(0, state.active - 1);
    pump();
  };
}

function trimWindow(nowMs) {
  const cutoff = nowMs - TOKEN_WINDOW_MS;
  while (state.tokenWindow.length && state.tokenWindow[0][0] < cutoff) {
    state.tokenWindow.shift();
  }
}

// Токены за окно, нормированные в «токены в минуту».
export function tokensPerMinute(nowMs = Date.now()) {
  trimWindow(nowMs);
  const sum = state.tokenWindow.reduce((a, [, t]) => a + t, 0);
  return Math.round((sum * 60_000) / TOKEN_WINDOW_MS);
}

// Зафиксировать исход вызова: подвинуть лимит (AIMD) и учесть токены.
export function recordResult({ outcome, totalTokens = 0, nowMs = Date.now() } = {}) {
  if (totalTokens > 0) state.tokenWindow.push([nowMs, totalTokens]);
  trimWindow(nowMs);

  if (outcome === 'throttle') {
    const old = state.limit;
    state.limit = nextLimitOnThrottle(state.limit, MIN);
    state.successStreak = 0;
    state.lastThrottleAt = nowMs;
    state.sawSaturation = false;
    if (state.limit !== old) {
      state.lastChangeAt = nowMs;
      state.lastChangeReason = 'throttle';
      log(`throttle at limit=${old} (tpm=${tokensPerMinute(nowMs)}, active=${state.active}) → lower to ${state.limit}`);
    } else {
      log(`throttle at floor limit=${old} (tpm=${tokensPerMinute(nowMs)}) — уже минимум`);
    }
    return;
  }

  if (outcome === 'ok') {
    state.successStreak += 1;
    if (state.successStreak >= PROBE_AFTER && state.sawSaturation && state.limit < MAX) {
      const old = state.limit;
      state.limit = nextLimitOnSuccess(state.limit, MAX);
      state.successStreak = 0;
      state.sawSaturation = false;
      state.lastChangeAt = nowMs;
      state.lastChangeReason = 'probe-up';
      log(`sustained success at limit=${old} (tpm=${tokensPerMinute(nowMs)}) → raise to ${state.limit}`);
    }
    return;
  }
  // 'error' (неретраябельная клиентская ошибка) — нейтрально, сбрасываем серию.
  state.successStreak = 0;
}

// Снимок ёмкости для эндпоинта и принятия решений сервисами.
export function stats(nowMs = Date.now()) {
  const tpm = tokensPerMinute(nowMs);
  const free = Math.max(0, state.limit - state.active);
  const tokenBudgetOk = TPM_BUDGET <= 0 || tpm < TPM_BUDGET;
  return {
    limit: state.limit,
    active: state.active,
    free,
    queued: state.queue.length,
    minLimit: MIN,
    maxLimit: MAX,
    tpm,
    tpmBudget: TPM_BUDGET,
    tokenWindowMs: TOKEN_WINDOW_MS,
    canSend: free > 0 && tokenBudgetOk,
    lastThrottleAt: state.lastThrottleAt,
    lastChangeAt: state.lastChangeAt,
    lastChangeReason: state.lastChangeReason,
  };
}

// Тестовый сброс состояния.
export function _resetForTest(overrides = {}) {
  state.limit = overrides.limit ?? Math.min(MAX, Math.max(MIN, START));
  state.active = 0;
  state.queue = [];
  state.successStreak = 0;
  state.sawSaturation = false;
  state.tokenWindow = [];
  state.lastThrottleAt = null;
  state.lastChangeAt = null;
  state.lastChangeReason = null;
}

export const LIMITS = { START, MIN, MAX, PROBE_AFTER, TOKEN_WINDOW_MS, TPM_BUDGET };

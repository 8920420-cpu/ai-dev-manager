// CONNECTOR-LIMITER-001: adaptive limiter for external LLM calls.
//
// The limiter is keyed by provider/endpoint. A DeepSeek 429 must reduce only the
// DeepSeek bucket, not the whole orchestrator and not OpenAI/local connectors.
// Public functions keep a default key for backward compatibility with tests and
// older callers.

function envInt(name, def) {
  const n = Number.parseInt(String(process.env[name] ?? '').trim(), 10);
  return Number.isFinite(n) ? n : def;
}

const START = Math.max(1, envInt('CONNECTOR_LIMIT_START', 6));
const MIN = Math.max(1, envInt('CONNECTOR_LIMIT_MIN', 2));
const MAX = Math.max(MIN, envInt('CONNECTOR_LIMIT_MAX', 32));
const PROBE_AFTER = Math.max(1, envInt('CONNECTOR_LIMIT_PROBE_AFTER', 15));
const TOKEN_WINDOW_MS = Math.max(1000, envInt('CONNECTOR_TOKEN_WINDOW_MS', 60_000));
const TPM_BUDGET = Math.max(0, envInt('CONNECTOR_TPM_BUDGET', 0));
const DEFAULT_KEY = 'default';

const log = (msg) => console.log(`[connector-limiter] ${msg}`);

export function classifyOutcome({ httpStatus = 0, errorMessage = '', aborted = false } = {}) {
  if (aborted) return 'throttle';
  if (httpStatus === 429) return 'throttle';
  if (httpStatus >= 500 && httpStatus <= 599) return 'throttle';
  const m = String(errorMessage || '').toLowerCase();
  if (m && /(rate.?limit|too many|quota|overload|capacity|server busy|tpm|token.?limit|503|429|econn|etimedout|socket hang|network|fetch failed|aborted)/.test(m)) {
    return 'throttle';
  }
  if (httpStatus >= 400 && httpStatus <= 499) return 'error';
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

function normalizeKey(key = DEFAULT_KEY) {
  const s = String(key ?? '').trim().toLowerCase();
  return s || DEFAULT_KEY;
}

function createState() {
  return {
    limit: Math.min(MAX, Math.max(MIN, START)),
    active: 0,
    queue: [],
    successStreak: 0,
    sawSaturation: false,
    tokenWindow: [],
    lastThrottleAt: null,
    lastChangeAt: null,
    lastChangeReason: null,
  };
}

const states = new Map();

function getState(key = DEFAULT_KEY) {
  const id = normalizeKey(key);
  if (!states.has(id)) states.set(id, createState());
  return states.get(id);
}

function resetState(st, overrides = {}) {
  st.limit = overrides.limit ?? Math.min(MAX, Math.max(MIN, START));
  st.active = 0;
  st.queue = [];
  st.successStreak = 0;
  st.sawSaturation = false;
  st.tokenWindow = [];
  st.lastThrottleAt = null;
  st.lastChangeAt = null;
  st.lastChangeReason = null;
}

function pump(st) {
  while (st.queue.length && st.active < st.limit) {
    const grant = st.queue.shift();
    grant();
  }
}

export async function acquire(key = DEFAULT_KEY) {
  const st = getState(key);
  await new Promise((resolve) => {
    if (st.active < st.limit) {
      st.active += 1;
      resolve();
    } else {
      st.sawSaturation = true;
      st.queue.push(() => {
        st.active += 1;
        resolve();
      });
    }
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    st.active = Math.max(0, st.active - 1);
    pump(st);
  };
}

function trimWindow(st, nowMs) {
  const cutoff = nowMs - TOKEN_WINDOW_MS;
  while (st.tokenWindow.length && st.tokenWindow[0][0] < cutoff) {
    st.tokenWindow.shift();
  }
}

export function tokensPerMinute(nowMs = Date.now(), key = DEFAULT_KEY) {
  const st = getState(key);
  trimWindow(st, nowMs);
  const sum = st.tokenWindow.reduce((a, [, t]) => a + t, 0);
  return Math.round((sum * 60_000) / TOKEN_WINDOW_MS);
}

export function recordResult({ outcome, totalTokens = 0, nowMs = Date.now(), key = DEFAULT_KEY } = {}) {
  const id = normalizeKey(key);
  const st = getState(id);
  if (totalTokens > 0) st.tokenWindow.push([nowMs, totalTokens]);
  trimWindow(st, nowMs);

  if (outcome === 'throttle') {
    const old = st.limit;
    st.limit = nextLimitOnThrottle(st.limit, MIN);
    st.successStreak = 0;
    st.lastThrottleAt = nowMs;
    st.sawSaturation = false;
    if (st.limit !== old) {
      st.lastChangeAt = nowMs;
      st.lastChangeReason = 'throttle';
      log(`${id}: throttle at limit=${old} (tpm=${tokensPerMinute(nowMs, id)}, active=${st.active}) -> lower to ${st.limit}`);
    } else {
      log(`${id}: throttle at floor limit=${old} (tpm=${tokensPerMinute(nowMs, id)})`);
    }
    return;
  }

  if (outcome === 'ok') {
    st.successStreak += 1;
    if (st.successStreak >= PROBE_AFTER && st.sawSaturation && st.limit < MAX) {
      const old = st.limit;
      st.limit = nextLimitOnSuccess(st.limit, MAX);
      st.successStreak = 0;
      st.sawSaturation = false;
      st.lastChangeAt = nowMs;
      st.lastChangeReason = 'probe-up';
      log(`${id}: sustained success at limit=${old} (tpm=${tokensPerMinute(nowMs, id)}) -> raise to ${st.limit}`);
    }
    return;
  }

  st.successStreak = 0;
}

export function stats(nowMs = Date.now(), key = DEFAULT_KEY) {
  const id = normalizeKey(key);
  const st = getState(id);
  const tpm = tokensPerMinute(nowMs, id);
  const free = Math.max(0, st.limit - st.active);
  const tokenBudgetOk = TPM_BUDGET <= 0 || tpm < TPM_BUDGET;
  return {
    key: id,
    limit: st.limit,
    active: st.active,
    free,
    queued: st.queue.length,
    minLimit: MIN,
    maxLimit: MAX,
    tpm,
    tpmBudget: TPM_BUDGET,
    tokenWindowMs: TOKEN_WINDOW_MS,
    canSend: free > 0 && tokenBudgetOk,
    lastThrottleAt: st.lastThrottleAt,
    lastChangeAt: st.lastChangeAt,
    lastChangeReason: st.lastChangeReason,
  };
}

export function allStats(nowMs = Date.now()) {
  return Object.fromEntries([...states.keys()].sort().map((key) => [key, stats(nowMs, key)]));
}

export function _resetForTest(overrides = {}) {
  states.clear();
  resetState(getState(DEFAULT_KEY), overrides);
}

export const LIMITS = { START, MIN, MAX, PROBE_AFTER, TOKEN_WINDOW_MS, TPM_BUDGET };

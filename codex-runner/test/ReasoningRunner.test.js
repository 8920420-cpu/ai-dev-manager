// Тесты ReasoningRunner: claim → runAgent → complete/release. Без сети и без Codex
// (http и runAgent — подделки), по образцу programmer-runner-тестов.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReasoningRunner, buildCompletionBody } from '../src/ReasoningRunner.js';

const silent = { info() {}, warn() {}, error() {} };
const okTask = { id: 't1', role: 'ARCHITECT', agentRunId: 'run1', systemPrompt: 'S', userPrompt: 'U', outputSchema: {} };

function http(overrides = {}) {
  const calls = { complete: [], release: [] };
  return {
    calls,
    claim: overrides.claim || (async () => ({ task: okTask })),
    complete: overrides.complete || (async (b) => { calls.complete.push(b); return { toStatus: 'ARCHITECTURE', nextRole: 'DECOMPOSER', verdict: 'READY' }; }),
    release: overrides.release || (async (id) => { calls.release.push(id); return { released: true }; }),
  };
}

test('успех: claim → runAgent → complete c verdict', async () => {
  const h = http();
  const runAgent = async () => ({ ok: true, verdict: { status: 'READY', summary: 's', findings: [] }, response: '{}', durationMs: 12 });
  const r = new ReasoningRunner({ http: h, runAgent, log: silent });
  const out = await r.pollOnce();
  assert.equal(out.success, true);
  assert.equal(h.calls.complete.length, 1);
  assert.equal(h.calls.complete[0].taskId, 't1');
  assert.equal(h.calls.complete[0].agentRunId, 'run1');
  assert.deepEqual(h.calls.complete[0].verdict, { status: 'READY', summary: 's', findings: [] });
  assert.equal(h.calls.release.length, 0);
});

test('пустой захват → idle, без вызовов', async () => {
  const h = http({ claim: async () => ({ task: null }) });
  const r = new ReasoningRunner({ http: h, runAgent: async () => { throw new Error('не должно вызываться'); }, log: silent });
  const out = await r.pollOnce();
  assert.equal(out.idle, true);
});

test('заблокированную входным гейтом задачу пробрасываем как blocked', async () => {
  const h = http({ claim: async () => ({ task: null, blocked: { taskId: 'tX', reason: 'missing_required_inputs' } }) });
  const r = new ReasoningRunner({ http: h, runAgent: async () => { throw new Error('нет'); }, log: silent });
  const out = await r.pollOnce();
  assert.equal(out.blocked.taskId, 'tX');
});

test('агент не справился → release, без complete', async () => {
  const h = http();
  const r = new ReasoningRunner({ http: h, runAgent: async () => ({ ok: false, error: 'codex_failed: x' }), log: silent });
  const out = await r.pollOnce();
  assert.equal(out.released, true);
  assert.equal(h.calls.release[0], 't1');
  assert.equal(h.calls.complete.length, 0);
});

test('агент бросил → release с причиной', async () => {
  const h = http();
  const r = new ReasoningRunner({ http: h, runAgent: async () => { throw new Error('boom'); }, log: silent });
  const out = await r.pollOnce();
  assert.equal(out.released, true);
  assert.equal(out.reason, 'boom');
});

test('сдача упала → release (не зависаем в захвате)', async () => {
  const h = http({ complete: async () => { throw new Error('5xx'); } });
  const r = new ReasoningRunner({ http: h, runAgent: async () => ({ ok: true, verdict: { status: 'READY' } }), log: silent });
  const out = await r.pollOnce();
  assert.equal(out.released, true);
  assert.match(out.reason, /complete_failed/);
});

test('busy-гард: нет свободных слотов → busy, без захвата', async () => {
  const h = http();
  const r = new ReasoningRunner({ http: h, runAgent: async () => ({ ok: true }), concurrency: 1, log: silent });
  r.inFlight = 1;
  const out = await r.tick();
  assert.deepEqual(out, { busy: true });
});

// PROVIDER-LIMIT-COOLDOWN-002 — пауза по лимиту + проверка движка перед возобновлением.
// ROLE-TIMEOUT-001: персональный бюджет прогона по коду роли (Архитектору мега-эпика
// общих 9 мин не хватало — обрыв на середине и перезапуск по кругу).
test('roleTimeoutsMs: таймаут роли из карты, остальным — общий; мусор отбрасывается', () => {
  const r = new ReasoningRunner({
    http: http(), runAgent: async () => ({ ok: true }), log: silent,
    taskTimeoutMs: 540000,
    roleTimeoutsMs: { architect: 1200000, DECOMPOSER: 'мусор', TASK_REVIEWER: -5 },
  });
  assert.equal(r.resolveTaskTimeoutMs('ARCHITECT'), 1200000, 'код роли нормализуется в верхний регистр');
  assert.equal(r.resolveTaskTimeoutMs('architect'), 1200000, 'роль задачи тоже нормализуется');
  assert.equal(r.resolveTaskTimeoutMs('DECOMPOSER'), 540000, 'нечисловое значение отброшено → общий');
  assert.equal(r.resolveTaskTimeoutMs('TASK_REVIEWER'), 540000, 'неположительное значение отброшено → общий');
  assert.equal(r.resolveTaskTimeoutMs(''), 540000, 'без роли — общий таймаут');
  assert.equal(r.resolveTaskTimeoutMs(null), 540000);
});

test('isProviderLimit: распознаёт лимит/квоту/перегрузку, но не обычные сбои', () => {
  assert.equal(ReasoningRunner.isProviderLimit("You've hit your usage limit. try again at 10:18 AM."), true);
  assert.equal(ReasoningRunner.isProviderLimit('rate limit exceeded'), true);
  assert.equal(ReasoningRunner.isProviderLimit('HTTP 429 Too Many Requests'), true);
  assert.equal(ReasoningRunner.isProviderLimit('overloaded_error (529)'), true);
  assert.equal(ReasoningRunner.isProviderLimit('boom'), false);
  assert.equal(ReasoningRunner.isProviderLimit('agent_timeout'), false);
});

test('лимит → пауза + probePending; в окне tick не клеймит движок', async () => {
  let clock = 1_000_000;
  let claimed = false;
  const h = http({ claim: async () => { claimed = true; return { task: okTask }; } });
  const r = new ReasoningRunner({
    http: h, log: silent, providerCooldownMs: 3_600_000, now: () => clock,
    runAgent: async () => ({ ok: false, error: "codex_failed: You've hit your usage limit. try again at 10:18 AM." }),
  });
  const first = await r.tick();
  assert.equal(first.released, true, 'первый провал отпускает задачу');
  assert.ok(r.cooldownUntil > clock, 'пауза установлена');
  assert.equal(r.probePending, true, 'помечено, что нужна проверка');

  claimed = false;
  const second = await r.tick();
  assert.equal(second.cooldown, true, 'в окне паузы tick пропускает claim');
  assert.equal(claimed, false, 'движок не вызывается во время паузы');
});

test('после паузы: probe провалился (всё ещё лимит) → пауза продлена, задачи НЕ берём', async () => {
  let clock = 1_000_000;
  let realClaims = 0;
  const h = http({ claim: async () => { realClaims += 1; return { task: okTask }; } });
  const r = new ReasoningRunner({
    http: h, log: silent, providerCooldownMs: 3_600_000, now: () => clock,
    // и реальная задача, и probe упираются в лимит
    runAgent: async () => ({ ok: false, error: 'usage limit reached' }),
  });
  await r.tick();               // словили лимит → пауза
  realClaims = 0;
  clock += 3_600_001;           // пауза истекла
  const t = await r.tick();     // должен сделать probe, а не брать реальную задачу
  assert.equal(t.cooldown, true, 'probe провалился → снова пауза');
  assert.equal(t.probe, 'failed');
  assert.equal(realClaims, 0, 'реальные задачи не клеймятся, пока проверка не прошла');
  assert.ok(r.cooldownUntil > clock, 'пауза продлена ещё на окно');
});

test('после паузы: probe прошёл → возобновляем, следующий tick клеймит задачу', async () => {
  let clock = 1_000_000;
  let realClaims = 0;
  const h = http({ claim: async () => { realClaims += 1; return { task: okTask }; } });
  const r = new ReasoningRunner({
    http: h, log: silent, providerCooldownMs: 3_600_000, now: () => clock,
    // probe (мини-задача) отвечает ok; реальная задача тоже ok
    runAgent: async (task) => task.id === '__provider_probe__'
      ? { ok: true, response: 'READY' }
      : { ok: true, verdict: { status: 'READY' }, response: '{}' },
  });
  // Смоделируем состояние «после лимита, пауза истекла».
  r.probePending = true;
  r.cooldownUntil = 0;
  const probeTick = await r.tick();
  assert.equal(probeTick.probe, 'passed', 'проверка движка прошла');
  assert.equal(realClaims, 0, 'на проверочном тике реальные задачи не берём');
  assert.equal(r.probePending, false, 'проверка снята');

  const work = await r.tick();
  assert.equal(work.success, true, 'следующий tick уже берёт реальную задачу');
  assert.equal(realClaims, 1);
});

test('обычный сбой (не лимит) НЕ включает паузу', async () => {
  const r = new ReasoningRunner({
    http: http(), log: silent, providerCooldownMs: 3_600_000,
    runAgent: async () => { throw new Error('boom'); },
  });
  await r.tick();
  assert.equal(r.cooldownUntil, 0, 'краш переигрывается штатно, без паузы');
  assert.equal(r.probePending, false);
});

test('buildCompletionBody: привязка к захвату + промпт для журнала', () => {
  const body = buildCompletionBody(okTask, { verdict: { status: 'READY' }, response: 'raw', durationMs: 7 });
  assert.equal(body.taskId, 't1');
  assert.equal(body.agentRunId, 'run1');
  assert.equal(body.durationMs, 7);
  assert.match(body.promptText, /S\n\nU/);
});

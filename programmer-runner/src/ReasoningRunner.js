// ROLE-ENGINE-ROUTING-001 — оркестрация рассуждающих ролей, делегированных
// внешнему движку (Codex/Claude Code): захватить reasoning-задачу у оркестратора,
// исполнить её headless-агентом (runAgent инъектируется — codex exec или Claude
// Agent SDK), сдать вердикт. Зеркало ProgrammerRunner/HostRunner: http и runAgent
// инъектируются, поэтому всю логику покрываем тестами с подделками (без сети и
// без живого движка).
//
// Concurrency: до N задач одновременно (in-flight счётчик); драйвер (bin) поднимает
// N воркеров над одним ReasoningRunner. Изоляции правок не нужно — роли работают в
// read-only режиме и ничего не коммитят (в отличие от программиста с worktree).
import { resolveCodeVersion } from './codeVersion.js';

export class ReasoningRunner {
  /**
   * @param {Object} deps
   * @param {{claim:Function, complete:Function, release:Function}} deps.http
   *   claim()        → Promise<{ task?:Object, blocked?:Object }>
   *   complete(body) → Promise<any>
   *   release(taskId)→ Promise<any>
   * @param {(task:Object, ctx:{signal:AbortSignal}) => Promise<{ok:boolean, verdict?:object, response?:string, durationMs?:number, error?:string}>} deps.runAgent
   * @param {number} [deps.taskTimeoutMs]  жёсткий таймаут на задачу; ДОЛЖЕН быть
   *   меньше орфан-таймаута оркестратора (RUNNER_ROLE_TIMEOUT_MS≈15 мин), иначе
   *   реапер освободит захват раньше нас и мы сдадим его «вхолостую».
   * @param {number} [deps.concurrency]
   * @param {Console} [deps.log]
   */
  constructor({ http, runAgent, taskTimeoutMs = 10 * 60 * 1000, concurrency = 2, log = console } = {}) {
    if (!http) throw new Error('ReasoningRunner: http required');
    if (typeof runAgent !== 'function') throw new Error('ReasoningRunner: runAgent required');
    this.http = http;
    this.runAgent = runAgent;
    this.taskTimeoutMs = taskTimeoutMs;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.log = log;
    this.inFlight = 0;
  }

  get availableSlots() {
    return Math.max(0, this.concurrency - this.inFlight);
  }

  // Один проход: захватить и обработать максимум одну задачу. Все слоты заняты —
  // { busy:true } (длинные codex-сессии не должны наступать друг на друга сверх лимита).
  async tick() {
    if (this.availableSlots <= 0) return { busy: true };
    this.inFlight += 1;
    try {
      return await this.pollOnce();
    } finally {
      this.inFlight -= 1;
    }
  }

  async pollOnce() {
    let claimed;
    const claimStart = Date.now();
    try {
      claimed = await this.http.claim();
    } catch (error) {
      this.log.error?.('reasoning claim failed', { error: error.message });
      return { error: error.message };
    }
    const claimMs = Date.now() - claimStart;
    // Входной гейт оркестратора заблокировал задачу (нет обязательных полей) —
    // не задача для нас, просто сообщаем и идём дальше.
    if (claimed?.blocked) return { blocked: claimed.blocked };
    const task = claimed?.task;
    if (!task) return { idle: true };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.taskTimeoutMs);
    let agentResult;
    try {
      agentResult = await this.runAgent(task, { signal: ac.signal });
    } catch (error) {
      // Исполнитель упал по-настоящему (краш/таймаут) — возвращаем захват в пул,
      // чтобы задачу не заклинило с назначенным агентом.
      clearTimeout(timer);
      const reason = ac.signal.aborted ? 'agent_timeout' : error.message;
      // OBSERVABILITY-REASONING-001: даже на краше пишем структурную строку, чтобы
      // отличать coldstart_failed/stuck/working_slow по логу.
      this.logRun(task, { outcome: ac.signal.aborted ? 'agent_timeout' : 'threw', claimMs }, reason);
      await this.safeRelease(task.id);
      return { taskId: task.id, released: true, reason };
    }
    clearTimeout(timer);

    if (!agentResult || agentResult.ok !== true) {
      const reason = agentResult?.error || 'agent_failed';
      this.logRun(task, { ...(agentResult || {}), claimMs }, reason);
      this.log.warn?.('reasoning agent did not succeed', { taskId: task.id, reason });
      await this.safeRelease(task.id);
      return { taskId: task.id, released: true, reason };
    }

    const body = buildCompletionBody(task, agentResult);
    const submitStart = Date.now();
    try {
      const res = await this.http.complete(body);
      const submitMs = Date.now() - submitStart;
      this.logRun(task, { ...agentResult, claimMs, submitMs }, null, res);
      return { taskId: task.id, success: true, complete: res };
    } catch (error) {
      // Сдача не прошла (сеть/5xx) — освобождаем захват, чтобы не зависнуть.
      this.log.error?.('reasoning complete failed', { taskId: task.id, error: error.message });
      await this.safeRelease(task.id);
      return { taskId: task.id, released: true, reason: `complete_failed: ${error.message}` };
    }
  }

  // OBSERVABILITY-REASONING-001: одна структурная строка на прогон — единый источник
  // правды для «что происходило» (фазы, ходы, токены, исход) и для KPI по логам.
  logRun(task, m = {}, reason = null, complete = null) {
    this.log.info?.('reasoning run', {
      taskId: task.id,
      role: task.role ?? null,
      outcome: m.outcome ?? (reason ? 'error' : 'success'),
      reason: reason ?? undefined,
      coldStartMs: m.coldStartMs ?? null,
      reasonMs: m.reasonMs ?? null,
      claimMs: m.claimMs ?? null,
      submitMs: m.submitMs ?? null,
      totalMs: m.durationMs ?? null,
      turns: m.turns ?? null,
      toolUses: m.toolUses ?? null,
      tokensIn: m.tokensIn ?? null,
      tokensOut: m.tokensOut ?? null,
      costUsd: m.costUsd ?? null,
      rateLimited: m.rateLimited ?? false,
      toStatus: complete?.toStatus,
      nextRole: complete?.nextRole,
      verdict: complete?.verdict,
    });
  }

  async safeRelease(taskId) {
    try {
      await this.http.release(taskId);
    } catch (error) {
      this.log.error?.('reasoning release failed', { taskId, error: error.message });
    }
  }
}

// Тело сдачи для POST /api/runner/reasoning-completed. agentRunId/taskId привязывают
// сдачу к захвату; verdict — структурированный исход (codex --output-schema), response
// — сырой текст (фолбэк-парсинг на стороне оркестратора), promptText — для журнала.
// kpi — метрики прогона для персиста в agent_runs (см. OBSERVABILITY-REASONING-001).
export function buildCompletionBody(task, agentResult) {
  const intOrNull = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    taskId: task.id,
    agentRunId: task.agentRunId,
    verdict: agentResult.verdict ?? null,
    response: typeof agentResult.response === 'string' ? agentResult.response : null,
    durationMs: numOrNull(agentResult.durationMs),
    promptText: `${String(task.systemPrompt || '')}\n\n${String(task.userPrompt || '')}`.slice(0, 100000),
    // KPI прогона (оркестратор запишет в agent_runs.token_input/token_output/cost/cold_start_ms/turns/outcome).
    tokensIn: intOrNull(agentResult.tokensIn),
    tokensOut: intOrNull(agentResult.tokensOut),
    costUsd: numOrNull(agentResult.costUsd),
    coldStartMs: intOrNull(agentResult.coldStartMs),
    turns: intOrNull(agentResult.turns),
    outcome: typeof agentResult.outcome === 'string' ? agentResult.outcome : null,
    // VERSION-KPI-TRACKING-001: метки версии кода раннера и использованной модели
    // (оркестратор пишет в agent_runs.code_version/model для дельт KPI по версиям).
    codeVersion: resolveCodeVersion(),
    model: typeof agentResult.model === 'string' && agentResult.model ? agentResult.model : null,
  };
}

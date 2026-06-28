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
    try {
      claimed = await this.http.claim();
    } catch (error) {
      this.log.error?.('reasoning claim failed', { error: error.message });
      return { error: error.message };
    }
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
      this.log.error?.('reasoning agent threw', { taskId: task.id, reason });
      await this.safeRelease(task.id);
      return { taskId: task.id, released: true, reason };
    }
    clearTimeout(timer);

    if (!agentResult || agentResult.ok !== true) {
      const reason = agentResult?.error || 'agent_failed';
      this.log.warn?.('reasoning agent did not succeed', { taskId: task.id, reason });
      await this.safeRelease(task.id);
      return { taskId: task.id, released: true, reason };
    }

    const body = buildCompletionBody(task, agentResult);
    try {
      const res = await this.http.complete(body);
      this.log.info?.('reasoning task completed', {
        taskId: task.id, role: task.role, toStatus: res?.toStatus, nextRole: res?.nextRole, verdict: res?.verdict,
      });
      return { taskId: task.id, success: true, complete: res };
    } catch (error) {
      // Сдача не прошла (сеть/5xx) — освобождаем захват, чтобы не зависнуть.
      this.log.error?.('reasoning complete failed', { taskId: task.id, error: error.message });
      await this.safeRelease(task.id);
      return { taskId: task.id, released: true, reason: `complete_failed: ${error.message}` };
    }
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
export function buildCompletionBody(task, agentResult) {
  return {
    taskId: task.id,
    agentRunId: task.agentRunId,
    verdict: agentResult.verdict ?? null,
    response: typeof agentResult.response === 'string' ? agentResult.response : null,
    durationMs: Number.isFinite(Number(agentResult.durationMs)) ? Number(agentResult.durationMs) : null,
    promptText: `${String(task.systemPrompt || '')}\n\n${String(task.userPrompt || '')}`.slice(0, 100000),
  };
}

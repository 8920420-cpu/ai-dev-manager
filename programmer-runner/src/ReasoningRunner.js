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
   * @param {Object<string,number>} [deps.roleTimeoutsMs]  ROLE-TIMEOUT-001:
   *   персональные таймауты по коду роли (ключ — ROLE_CODE). Архитектору мега-эпика
   *   общего reasoning-бюджета не хватает (обрыв на середине → перезапуск по кругу).
   *   Контракт «< орфан-таймаута» обязателен для КАЖДОГО значения карты.
   * @param {number} [deps.concurrency]
   * @param {Console} [deps.log]
   */
  constructor({ http, runAgent, taskTimeoutMs = 10 * 60 * 1000, roleTimeoutsMs = {}, concurrency = 2,
                providerCooldownMs = 60 * 60 * 1000, probeTask = null,
                now = () => Date.now(), log = console } = {}) {
    if (!http) throw new Error('ReasoningRunner: http required');
    if (typeof runAgent !== 'function') throw new Error('ReasoningRunner: runAgent required');
    this.http = http;
    this.runAgent = runAgent;
    this.taskTimeoutMs = taskTimeoutMs;
    // Нормализуем карту ролевых таймаутов: код роли — верхним регистром, значение —
    // конечное положительное число; мусор отбрасываем (падать из-за конфига нельзя).
    this.roleTimeoutsMs = {};
    for (const [role, ms] of Object.entries(roleTimeoutsMs || {})) {
      const n = Number(ms);
      if (Number.isFinite(n) && n > 0) this.roleTimeoutsMs[String(role).trim().toUpperCase()] = n;
    }
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    // PROVIDER-LIMIT-COOLDOWN-002: при «мягком» отказе движка (превышение лимита
    // подписки/квоты/троттлинг/перегрузка) останавливаем приём задач на
    // providerCooldownMs (дефолт 1 час — настройка). По истечении паузы НЕ бросаемся
    // сразу в реальные задачи, а делаем лёгкую ПРОВЕРКУ движка (probe); только если
    // проверка прошла — возобновляем работу, иначе продлеваем паузу. Задачи не
    // мусолятся впустую, движок берётся в работу лишь когда реально снова доступен.
    this.providerCooldownMs = Math.max(0, Number(providerCooldownMs) || 0);
    this.probeTask = probeTask || ReasoningRunner.DEFAULT_PROBE_TASK;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.cooldownUntil = 0;
    this.probePending = false;
    this.log = log;
    this.inFlight = 0;
  }

  get availableSlots() {
    return Math.max(0, this.concurrency - this.inFlight);
  }

  // ROLE-TIMEOUT-001: жёсткий таймаут прогона для конкретной роли — из карты
  // roleTimeoutsMs, иначе общий taskTimeoutMs.
  resolveTaskTimeoutMs(role) {
    return this.roleTimeoutsMs[String(role || '').trim().toUpperCase()] ?? this.taskTimeoutMs;
  }

  // «Мягкий» отказ провайдера — лимит подписки/квоты/троттлинг/перегрузка. Долбить
  // его бессмысленно: держится долго. Отличаем от реальных сбоев (краш/таймаут/сеть),
  // которые штатно переигрываются на INTERVAL_MS.
  static isProviderLimit(reason) {
    // Разделитель между словами — пробел/подчёркивание/дефис: провайдеры пишут и
    // «usage limit», и «rate_limit_error», и «too-many-requests». Набор синхронизирован
    // с ProgrammerRunner.isProviderLimit (канон): +«hit your session limit»/403/«resets HH:MM».
    // claude_code при исчерпании подписки пишет «You've hit your session limit · resets 6:50am» —
    // без этих паттернов пауза PROVIDER-LIMIT-COOLDOWN-002 не срабатывала (churn 10.07).
    return /hit your session limit|usage[\s_-]?limit|rate[\s_-]?limit|too[\s_-]?many[\s_-]?requests|\b403\b|\b429\b|\b529\b|quota|insufficient|overloaded|try again (at|later|in)|resets?\s+\d/i.test(
      String(reason || ''),
    );
  }

  // Зафиксировать провайдер-лимит: включить общий (на инстанс) cooldown и пометить,
  // что перед возобновлением нужна проверка движка.
  noteFailureReason(reason) {
    if (ReasoningRunner.isProviderLimit(reason) && this.providerCooldownMs > 0) {
      this.cooldownUntil = this.now() + this.providerCooldownMs;
      this.probePending = true;
      this.log.warn?.('провайдер-лимит — пауза до восстановления', {
        reason, cooldownMs: this.providerCooldownMs, until: new Date(this.cooldownUntil).toISOString(),
      });
    }
  }

  // Лёгкая проверка движка тем же runAgent на минимальной задаче. true — движок
  // снова доступен (пауза снята); false — всё ещё лимит (пауза продлена ещё на окно).
  async probeProvider() {
    let res;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(this.taskTimeoutMs, 120000));
    try {
      res = await this.runAgent(this.probeTask, { signal: ac.signal });
    } catch (error) {
      res = { ok: false, error: error.message };
    } finally {
      clearTimeout(timer);
    }
    if (res && res.ok === true) {
      this.log.info?.('провайдер-проверка пройдена — возобновляю приём задач');
      return true;
    }
    if (ReasoningRunner.isProviderLimit(res?.error)) {
      this.cooldownUntil = this.now() + this.providerCooldownMs;
      this.log.warn?.('провайдер всё ещё в лимите — пауза продлена', {
        until: new Date(this.cooldownUntil).toISOString(),
      });
      return false;
    }
    return true; // иная ошибка проверки (сеть/таймаут) — не лимит, не зависаем в паузе
  }

  // Один проход: захватить и обработать максимум одну задачу. Все слоты заняты —
  // { busy:true } (длинные codex-сессии не должны наступать друг на друга сверх лимита).
  async tick() {
    // В окне провайдер-паузы не клеймим и не вызываем движок — усмиряем шторм
    // claim→limit→release при исчерпанном лимите подписки.
    if (this.now() < this.cooldownUntil) return { cooldown: true, until: this.cooldownUntil };
    // Пауза истекла — прежде чем брать реальные задачи, ПРОВЕРЯЕМ движок.
    if (this.probePending) {
      const ok = await this.probeProvider();
      if (!ok) return { cooldown: true, until: this.cooldownUntil, probe: 'failed' };
      this.probePending = false;
      return { probe: 'passed' };
    }
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
    const timer = setTimeout(() => ac.abort(), this.resolveTaskTimeoutMs(task.role));
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
      this.noteFailureReason(reason);
      await this.safeRelease(task.id);
      return { taskId: task.id, released: true, reason };
    }
    clearTimeout(timer);

    if (!agentResult || agentResult.ok !== true) {
      const reason = agentResult?.error || 'agent_failed';
      this.logRun(task, { ...(agentResult || {}), claimMs }, reason);
      this.log.warn?.('reasoning agent did not succeed', { taskId: task.id, reason });
      this.noteFailureReason(reason);
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

// Минимальная синтетическая задача для проверки движка после паузы: тривиальный
// промпт, никаких инструментов/схемы/проекта — только чтобы понять, отвечает ли
// движок или всё ещё в лимите. Дёшево и не зависит от реальной очереди задач.
ReasoningRunner.DEFAULT_PROBE_TASK = {
  id: '__provider_probe__',
  role: '__provider_probe__',
  systemPrompt: '',
  userPrompt: 'Reply with the single word READY. Do not use any tools.',
  outputSchema: {},
  projectPath: '',
};

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
    // TOKEN-SPLIT-001: разбивка входа → agent_runs.token_cache_read/token_cache_creation
    // (свежий ввод = token_input − cache_read − cache_creation). null для движков без
    // prompt-кэша — оркестратор через COALESCE не затрёт уже записанное.
    tokensCacheRead: intOrNull(agentResult.tokensCacheRead),
    tokensCacheCreation: intOrNull(agentResult.tokensCacheCreation),
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

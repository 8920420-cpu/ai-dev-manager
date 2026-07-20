// Оркестрация роли PROGRAMMER (стадия CODING): захватить claude-задачу у
// оркестратора, выполнить её headless-агентом в рабочем дереве проекта, сдать
// результат. Зеркало host-runner/HostRunner: http и runAgent инъектируются,
// поэтому всю логику покрываем тестами с подделками (без сети и без Claude).
//
// Concurrency: до N задач одновременно (in-flight счётчик). Каждый вызов pollOnce
// обрабатывает одну задачу; драйвер (bin) запускает N воркеров над одним
// ProgrammerRunner. Изоляция параллельных правок — в runAgent (git worktree, см.
// claudeAgent.js): дорогой шаг LLM параллелится, слияние в main сериализуется.
// concurrency=1 → поведение прежнее (busy-гард не пускает второй tick).
import { resolveCodeVersion } from './codeVersion.js';

export class ProgrammerRunner {
  /**
   * @param {Object} deps
   * @param {{claim:Function, complete:Function, release:Function}} deps.http
   *   claim()        → Promise<{ task?:Object }>  (распакованный data оркестратора)
   *   complete(body) → Promise<any>
   *   release(taskId, opts?) → Promise<any>  opts.reason/opts.meta прокидываются
   *     оркестратору (outcome/error_text прогона, KPI-событие лимита ходов)
   * @param {(task:Object, ctx:{signal:AbortSignal}) => Promise<{ok:boolean, changedFiles?:string[], result?:any, error?:string}>} deps.runAgent
   * @param {number} [deps.taskTimeoutMs]  жёсткий таймаут на задачу; ДОЛЖЕН быть
   *   меньше орфан-таймаута оркестратора (CLAUDE_ASSIGN_TIMEOUT_MS≈30 мин), иначе
   *   реапер освободит задачу раньше нас и мы сдадим её «вхолостую».
   * @param {Console} [deps.log]
   */
  constructor({
    http, runAgent, taskTimeoutMs = 20 * 60 * 1000, concurrency = 1,
    providerCooldownMs = 60 * 60 * 1000, now = () => Date.now(), log = console,
  } = {}) {
    if (!http) throw new Error('ProgrammerRunner: http required');
    if (typeof runAgent !== 'function') throw new Error('ProgrammerRunner: runAgent required');
    this.http = http;
    this.runAgent = runAgent;
    this.taskTimeoutMs = taskTimeoutMs;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.providerCooldownMs = Math.max(0, Number(providerCooldownMs) || 0);
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.cooldownUntil = 0;
    this.log = log;
    this.inFlight = 0;
  }

  // Свободные слоты для новых захватов (драйвер заполняет их параллельно).
  get availableSlots() {
    return Math.max(0, this.concurrency - this.inFlight);
  }

  static isProviderLimit(reason) {
    return /hit your session limit|usage[\s_-]?limit|rate[\s_-]?limit|too[\s_-]?many[\s_-]?requests|\b403\b|\b429\b|\b529\b|quota|insufficient|overloaded|try again (at|later|in)|resets?\s+\d/i.test(
      String(reason || ''),
    );
  }

  providerCooldownUntil(reason) {
    const reset = parseProviderResetAt(reason, this.now());
    if (reset && reset > this.now()) return reset;
    return this.now() + this.providerCooldownMs;
  }

  noteFailureReason(reason) {
    if (ProgrammerRunner.isProviderLimit(reason) && this.providerCooldownMs > 0) {
      this.cooldownUntil = this.providerCooldownUntil(reason);
      this.log.warn?.('programmer provider limit - cooldown enabled', {
        reason,
        until: new Date(this.cooldownUntil).toISOString(),
      });
    }
  }

  // Один проход: захватить и обработать максимум одну задачу. Если все слоты
  // заняты — { busy:true } (длинные сессии агента не должны наступать друг на
  // друга сверх лимита параллелизма). При concurrency=1 это прежний busy-гард.
  async tick() {
    if (this.now() < this.cooldownUntil) return { cooldown: true, until: this.cooldownUntil };
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
      this.log.error?.('programmer claim failed', { error: error.message });
      return { error: error.message };
    }
    const task = claimed?.task;
    if (!task) return { idle: true };

    // PROGRAMMER-OBSERVABILITY-001: стенка-часы прогона для лога метрик (turns/ms/
    // tokens/cost/changedFiles/conflictFiles) — по образцу claude-reasoning-runner.
    const startedAt = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.taskTimeoutMs);
    let agentResult;
    try {
      agentResult = await this.runAgent(task, { signal: ac.signal });
    } catch (error) {
      // Исполнитель упал по-настоящему (краш/таймаут), а не вернул вердикт «провал».
      // Возвращаем захват в пул, чтобы задачу не заклинило с назначенным агентом.
      clearTimeout(timer);
      const reason = ac.signal.aborted ? 'agent_timeout' : error.message;
      this.log.error?.('programmer agent threw', { taskId: task.id, reason, totalMs: Date.now() - startedAt });
      this.noteFailureReason(reason);
      // Прокидываем причину: без неё в agent_runs остаётся outcome='released' и
      // источник петли захват→провал→release установить нельзя (инцидент 03.07.2026).
      await this.safeRelease(task.id, { reason });
      return { taskId: task.id, released: true, reason };
    }
    clearTimeout(timer);

    if (!agentResult || agentResult.ok !== true) {
      const reason = agentResult?.error || 'agent_reported_failure';
      const metrics = runMetrics(agentResult, Date.now() - startedAt);

      // TASK-NEEDS-INPUT-001: агент не стал гадать, а задал человеку вопрос.
      // Это НЕ провал: возвращать задачу в очередь бессмысленно (следующий заход
      // упрётся в ту же неоднозначность и сожжёт слот), поэтому паркуем её в
      // NEEDS_INPUT. Если ручка недоступна (старый оркестратор, сеть) — падаем
      // обратно на обычный release, чтобы задача не зависла с захватом.
      if (agentResult?.needsInput?.question && typeof this.http.needsInput === 'function') {
        this.log.info?.('programmer asks for input', {
          taskId: task.id, question: agentResult.needsInput.question, ...metrics,
        });
        try {
          const parked = await this.http.needsInput(task.id, agentResult.needsInput);
          return { taskId: task.id, needsInput: true, question: agentResult.needsInput.question, parked };
        } catch (error) {
          this.log.error?.('programmer needs-input failed, releasing instead', {
            taskId: task.id, error: error.message,
          });
        }
      }

      this.noteFailureReason(reason);
      // Упор в лимит ходов — ОТДЕЛЬНЫЙ помеченный исход: логируем заметно и сообщаем
      // оркестратору reason+meta, чтобы он записал событие KPI (отслеживаем работу
      // Декомпозитора/Архитектора — задача не уложилась в бюджет ходов).
      if (agentResult?.limitHit) {
        this.log.error?.('programmer LIMIT EXCEEDED (max turns)', {
          taskId: task.id, numTurns: agentResult.meta?.numTurns, maxTurns: agentResult.meta?.maxTurns, ...metrics,
        });
        await this.safeRelease(task.id, { reason: 'max_turns_exceeded', meta: agentResult.meta });
        return { taskId: task.id, released: true, reason, limitHit: true, meta: agentResult.meta };
      }
      // conflictFiles видны отдельно: integrate_conflict — самая частая непродуктивная
      // трата слота, и по списку файлов сразу ясно, код это или артефакт (см. deny-list).
      this.log.warn?.('programmer agent did not succeed', {
        taskId: task.id, reason, conflict: agentResult?.conflict || undefined,
        conflictFiles: agentResult?.conflictingFiles,
        blockerKind: agentResult?.blockerKind || undefined, ...metrics,
      });
      // meta прокидываем, если исполнитель его вернул (turns, кросс-сервисный блокер) —
      // иначе только reason. PROGRAMMER-CROSS-SERVICE-PREFLIGHT-001: blockerKind в meta
      // говорит оркестратору увести задачу на переразбиение, а не оставить в CODING.
      const meta = { ...(agentResult?.meta || {}) };
      if (agentResult?.blockerKind) meta.blockerKind = agentResult.blockerKind;
      await this.safeRelease(task.id, Object.keys(meta).length ? { reason, meta } : { reason });
      return { taskId: task.id, released: true, reason };
    }

    const body = buildCompletionBody(task, agentResult);
    try {
      const res = await this.http.complete(body);
      this.log.info?.('programmer task completed', {
        taskId: task.id,
        nextRole: res?.nextRole,
        duplicate: res?.duplicate,
        ...runMetrics(agentResult, Date.now() - startedAt),
      });
      return { taskId: task.id, success: true, complete: res };
    } catch (error) {
      // Сдача не прошла (сеть/5xx) — освобождаем захват, чтобы не зависнуть в CODING.
      const reason = `complete_failed: ${error.message}`;
      this.log.error?.('programmer complete failed', { taskId: task.id, error: error.message });
      await this.safeRelease(task.id, { reason });
      return { taskId: task.id, released: true, reason };
    }
  }

  async safeRelease(taskId, opts) {
    try {
      await this.http.release(taskId, opts);
    } catch (error) {
      this.log.error?.('programmer release failed', { taskId, error: error.message });
    }
  }
}

// PROGRAMMER-OBSERVABILITY-001: компактная сводка метрик прогона для лога —
// turns/totalMs/changedFiles/conflictFiles/токены/стоимость/cold start. Образец —
// metrics() в claudeReasoningAgent.js: раньше в логе программиста был виден только
// исход, но не «куда ушло время». undefined-поля JSON.stringify опускает, поэтому
// старый исход без usage даёт чистую строку.
export function runMetrics(agentResult, totalMs) {
  const agent = agentResult?.result?.agent || {};
  const fin = (v) => (Number.isFinite(v) ? v : undefined);
  return {
    turns: fin(agent.numTurns),
    totalMs,
    coldStartMs: fin(agent.coldStartMs),
    changedFiles: Array.isArray(agentResult?.changedFiles) ? agentResult.changedFiles.length : undefined,
    conflictFiles: Array.isArray(agentResult?.conflictingFiles) && agentResult.conflictingFiles.length
      ? agentResult.conflictingFiles.length : undefined,
    tokensIn: fin(agent.tokensIn),
    tokensOut: fin(agent.tokensOut),
    costUsd: fin(agent.costUsd) ?? fin(agent.totalCostUsd),
    model: typeof agentResult?.model === 'string' ? agentResult.model : undefined,
  };
}

export function parseProviderResetAt(reason, nowMs = Date.now()) {
  const text = String(reason || '');
  const m = text.match(/(?:reset|resets|try again at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return null;
  const ampm = m[3]?.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const d = new Date(nowMs);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Тело сдачи для POST /api/scanner/task-completed. Поля берём из блока completion
// захваченной задачи (там лежат точные project/service/title/sourceDocument и,
// главное, completionKey с id события AGENT_ASSIGNED — он гарантирует
// идемпотентность повторной сдачи).
export function buildCompletionBody(task, agentResult) {
  const c = task.completion || {};
  const agent = agentResult.result?.agent || {};
  // Только конечные числа отправляем как отдельные поля; иначе поле не выставляем
  // (undefined) — старый раннер без usage/cold start даёт валидное тело (оркестратор
  // COALESCE-ит null → нули без падения). Обратная совместимость обязательна.
  const numOrUndef = (v) => (Number.isFinite(v) ? v : undefined);
  // Число «проходов» (ходов агента) до завершения — скалярная метрика для Монитора
  // («за сколько проходов программист справляется»). result сериализуется в строку
  // на стороне оркестратора, поэтому numTurns отправляем отдельным числом, а не
  // прячем внутрь result.
  const numTurns = agent.numTurns;
  // PROGRAMMER-USAGE-KPI-001: usage/стоимость/cold start прогона — отдельными полями
  // сдачи с ТОЧНО такими ключами (контракт с оркестратором, normalizeRunKpi). costUsd
  // допускается из totalCostUsd (уже лежал в result.agent).
  const costUsd = numOrUndef(agent.costUsd) ?? numOrUndef(agent.totalCostUsd);
  return {
    taskId: task.id,
    completionKey: c.completionKey,
    project: c.project ?? task.project,
    service: c.service ?? task.service,
    title: c.title ?? task.title,
    sourceDocument: c.sourceDocument,
    changedFiles: Array.isArray(agentResult.changedFiles) ? agentResult.changedFiles : [],
    // Ветка/коммит worktree программиста для стадии GIT_INTEGRATION: когда changedFiles
    // пуст (no_changed_files/nothing_to_stage), код всё равно лежит в ветке worktree —
    // GI вливает её в main по этим полям. Шлём всегда, в т.ч. null (пустая дельта →
    // deliveredCommit=null): иначе конвейер «зелёный», а код не доехал (инцидент 05.07).
    worktreeBranch: agentResult.branch ?? null,
    deliveredCommit: agentResult.commit ?? null,
    result: agentResult.result ?? {},
    numTurns: numOrUndef(numTurns),
    // Токены/стоимость/cold start прогона → agent_runs (token_input/token_output/
    // token_cache_read/token_cache_creation/cost/cold_start_ms).
    tokensIn: numOrUndef(agent.tokensIn),
    tokensOut: numOrUndef(agent.tokensOut),
    tokensCacheRead: numOrUndef(agent.tokensCacheRead),
    tokensCacheCreation: numOrUndef(agent.tokensCacheCreation),
    costUsd,
    coldStartMs: numOrUndef(agent.coldStartMs),
    // VERSION-KPI-TRACKING-001: версия кода раннера (промт программиста в коде → она
    // же версионирует промт) и использованная модель — оркестратор кладёт в payload
    // события сдачи (KPI программиста живут в task_events).
    codeVersion: resolveCodeVersion(),
    model: typeof agentResult.model === 'string' && agentResult.model ? agentResult.model : null,
  };
}

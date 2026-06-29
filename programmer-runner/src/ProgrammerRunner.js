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
   *   release(taskId)→ Promise<any>
   * @param {(task:Object, ctx:{signal:AbortSignal}) => Promise<{ok:boolean, changedFiles?:string[], result?:any, error?:string}>} deps.runAgent
   * @param {number} [deps.taskTimeoutMs]  жёсткий таймаут на задачу; ДОЛЖЕН быть
   *   меньше орфан-таймаута оркестратора (CLAUDE_ASSIGN_TIMEOUT_MS≈30 мин), иначе
   *   реапер освободит задачу раньше нас и мы сдадим её «вхолостую».
   * @param {Console} [deps.log]
   */
  constructor({ http, runAgent, taskTimeoutMs = 20 * 60 * 1000, concurrency = 1, log = console } = {}) {
    if (!http) throw new Error('ProgrammerRunner: http required');
    if (typeof runAgent !== 'function') throw new Error('ProgrammerRunner: runAgent required');
    this.http = http;
    this.runAgent = runAgent;
    this.taskTimeoutMs = taskTimeoutMs;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.log = log;
    this.inFlight = 0;
  }

  // Свободные слоты для новых захватов (драйвер заполняет их параллельно).
  get availableSlots() {
    return Math.max(0, this.concurrency - this.inFlight);
  }

  // Один проход: захватить и обработать максимум одну задачу. Если все слоты
  // заняты — { busy:true } (длинные сессии агента не должны наступать друг на
  // друга сверх лимита параллелизма). При concurrency=1 это прежний busy-гард.
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
      this.log.error?.('programmer claim failed', { error: error.message });
      return { error: error.message };
    }
    const task = claimed?.task;
    if (!task) return { idle: true };

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
      this.log.error?.('programmer agent threw', { taskId: task.id, reason });
      await this.safeRelease(task.id);
      return { taskId: task.id, released: true, reason };
    }
    clearTimeout(timer);

    if (!agentResult || agentResult.ok !== true) {
      const reason = agentResult?.error || 'agent_reported_failure';
      // Упор в лимит ходов — ОТДЕЛЬНЫЙ помеченный исход: логируем заметно и сообщаем
      // оркестратору reason+meta, чтобы он записал событие KPI (отслеживаем работу
      // Декомпозитора/Архитектора — задача не уложилась в бюджет ходов).
      if (agentResult?.limitHit) {
        this.log.error?.('programmer LIMIT EXCEEDED (max turns)', {
          taskId: task.id, numTurns: agentResult.meta?.numTurns, maxTurns: agentResult.meta?.maxTurns,
        });
        await this.safeRelease(task.id, { reason: 'max_turns_exceeded', meta: agentResult.meta });
        return { taskId: task.id, released: true, reason, limitHit: true, meta: agentResult.meta };
      }
      this.log.warn?.('programmer agent did not succeed', { taskId: task.id, reason });
      await this.safeRelease(task.id);
      return { taskId: task.id, released: true, reason };
    }

    const body = buildCompletionBody(task, agentResult);
    try {
      const res = await this.http.complete(body);
      this.log.info?.('programmer task completed', {
        taskId: task.id,
        nextRole: res?.nextRole,
        duplicate: res?.duplicate,
      });
      return { taskId: task.id, success: true, complete: res };
    } catch (error) {
      // Сдача не прошла (сеть/5xx) — освобождаем захват, чтобы не зависнуть в CODING.
      this.log.error?.('programmer complete failed', { taskId: task.id, error: error.message });
      await this.safeRelease(task.id);
      return { taskId: task.id, released: true, reason: `complete_failed: ${error.message}` };
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

// Тело сдачи для POST /api/scanner/task-completed. Поля берём из блока completion
// захваченной задачи (там лежат точные project/service/title/sourceDocument и,
// главное, completionKey с id события AGENT_ASSIGNED — он гарантирует
// идемпотентность повторной сдачи).
export function buildCompletionBody(task, agentResult) {
  const c = task.completion || {};
  // Число «проходов» (ходов агента) до завершения — скалярная метрика для Монитора
  // («за сколько проходов программист справляется»). result сериализуется в строку
  // на стороне оркестратора, поэтому numTurns отправляем отдельным числом, а не
  // прячем внутрь result.
  const numTurns = agentResult.result?.agent?.numTurns;
  return {
    taskId: task.id,
    completionKey: c.completionKey,
    project: c.project ?? task.project,
    service: c.service ?? task.service,
    title: c.title ?? task.title,
    sourceDocument: c.sourceDocument,
    changedFiles: Array.isArray(agentResult.changedFiles) ? agentResult.changedFiles : [],
    result: agentResult.result ?? {},
    numTurns: Number.isFinite(numTurns) ? numTurns : undefined,
    // VERSION-KPI-TRACKING-001: версия кода раннера (промт программиста в коде → она
    // же версионирует промт) и использованная модель — оркестратор кладёт в payload
    // события сдачи (KPI программиста живут в task_events).
    codeVersion: resolveCodeVersion(),
    model: typeof agentResult.model === 'string' && agentResult.model ? agentResult.model : null,
  };
}

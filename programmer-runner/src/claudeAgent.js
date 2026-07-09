// Обёртка над Claude Agent SDK: запускает headless Claude Code на задаче в рабочем
// дереве проекта и возвращает машинно-читаемый исход для ProgrammerRunner. Это
// «грязный край» сервиса (реальные побочные эффекты: SDK + git), по аналогии с
// host-runner/actions.js — юнит-тестами покрыт инъектируемый ProgrammerRunner, а
// не этот модуль.
//
// Изоляция параллельных задач: агент всегда работает в собственном git worktree
// СВОЕГО микросервиса (см. worktreeManager.js), а его diff серилизованно
// применяется в main под глобальным локом. Это безопасно при concurrency>1.
import { query } from '@anthropic-ai/claude-agent-sdk';

import { resolveRepo, loadRepoMap } from './repoResolver.js';
import { buildPrompt, parseAgentJson } from './promptBuilder.js';
import { WorktreeManager } from './worktreeManager.js';

// Набор инструментов, авто-разрешённых агенту. permissionMode='bypassPermissions'
// и так утверждает всё; allowedTools оставляем как явную белую границу.
const DEFAULT_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'TodoWrite'];

// Связать внешний AbortSignal с AbortController для SDK.
function linkSignal(signal) {
  const ac = new AbortController();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  return ac;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// PROGRAMMER-USAGE-KPI-001: токены/стоимость из финального result-сообщения SDK.
// Образец — extractUsage() в claudeReasoningAgent.js. ВАЖНО: result.usage —
// контекст ПОСЛЕДНЕГО хода (не сумма за сессию), а у программиста прогон длинный
// (30–60 ходов), поэтому для KPI берём result.modelUsage — КУМУЛЯТИВНЫЕ по моделям
// итоги за всю сессию (сходятся с total_cost_usd). Фолбэк на usage — для старых
// версий SDK без modelUsage.
//   tokensInput — свежий (uncached) ввод; tokensCacheCreation — запись в prompt-кэш;
//   tokensCacheRead — чтение из кэша (доминирует в tool-loop); tokensOut — вывод.
//   tokensIn — ПОЛНАЯ сумма входа (контракт tokensIn с оркестратором).
function extractUsage(final) {
  const costUsd = num(final?.total_cost_usd);
  const mu = final?.modelUsage;
  if (mu && typeof mu === 'object') {
    let tokensInput = 0;
    let tokensCacheCreation = 0;
    let tokensCacheRead = 0;
    let tokensOut = 0;
    for (const m of Object.values(mu)) {
      tokensInput += num(m?.inputTokens);
      tokensCacheCreation += num(m?.cacheCreationInputTokens);
      tokensCacheRead += num(m?.cacheReadInputTokens);
      tokensOut += num(m?.outputTokens);
    }
    return {
      tokensIn: tokensInput + tokensCacheCreation + tokensCacheRead,
      tokensInput, tokensCacheCreation, tokensCacheRead, tokensOut, costUsd,
    };
  }
  const u = final?.usage || {};
  const tokensInput = num(u.input_tokens);
  const tokensCacheCreation = num(u.cache_creation_input_tokens);
  const tokensCacheRead = num(u.cache_read_input_tokens);
  const tokensOut = num(u.output_tokens);
  return {
    tokensIn: tokensInput + tokensCacheCreation + tokensCacheRead,
    tokensInput, tokensCacheCreation, tokensCacheRead, tokensOut, costUsd,
  };
}

/**
 * Один прогон SDK в заданном рабочем дереве. Возвращает нормализованный исход
 * БЕЗ вычисления changedFiles — список файлов считает вызывающий (по worktree-
 * diff или снимку основного дерева).
 * @returns {Promise<{ok:boolean, error?:string, result?:object}>}
 */
async function runSdkOnce({ cwd, env, task, signal, model, maxTurns, allowedTools, log }) {
  const prompt = buildPrompt(task);
  const ac = linkSignal(signal);

  // PROGRAMMER-USAGE-KPI-001: cold start — от вызова query() до первого system/init
  // сообщения SDK (спавн нативного модуля + авторизация подписки + hooks). Образец —
  // metrics() в claudeReasoningAgent.js.
  const started = Date.now();
  let initAt = null;
  let final = null;
  try {
    for await (const message of query({
      prompt,
      options: {
        cwd,
        model,
        maxTurns,
        permissionMode: 'bypassPermissions',
        allowedTools,
        abortController: ac,
        env: { ...process.env, ...env },
      },
    })) {
      if (message.type === 'system' && initAt == null) initAt = Date.now();
      if (message.type === 'result') final = message;
    }
  } catch (error) {
    if (ac.signal.aborted) return { ok: false, error: 'agent_aborted' };
    return { ok: false, error: `agent_threw: ${error.message}` };
  }

  // Упор в лимит ходов (maxTurns) — ОТДЕЛЬНЫЙ помеченный исход, а не «просто
  // провал». Сигнал, что задача не уложилась в бюджет ходов: почти всегда её плохо
  // нарезали (Декомпозитор/Архитектор). Прокидываем limitHit + метрики, чтобы
  // оркестратор записал это в KPI, а не потерял в общем reason.
  if (final && final.subtype === 'error_max_turns') {
    log.warn?.('claudeAgent: упор в лимит ходов', { taskId: task.id, numTurns: final.num_turns, maxTurns });
    return {
      ok: false,
      error: 'max_turns_exceeded',
      limitHit: true,
      meta: { numTurns: final.num_turns ?? maxTurns, maxTurns },
    };
  }

  const ok = !!final && final.subtype === 'success' && final.is_error !== true;
  const parsed = ok ? parseAgentJson(final.result) : null;
  // Агент явно сообщил о провале — уважаем.
  if (parsed && parsed.success === false) {
    const out = { ok: false, error: `agent_reported_failure: ${parsed.summary || ''}`.trim() };
    // PROGRAMMER-CROSS-SERVICE-PREFLIGHT-001: агент явно назвал блокер — правку
    // контракта/сгенерированного кода ДРУГОГО сервиса. Помечаем исход, чтобы
    // оркестратор увёл задачу на переразбиение, а не гонял её по кругу в CODING.
    const blockedBy = typeof parsed.blocked_by_service === 'string' ? parsed.blocked_by_service.trim() : '';
    if (blockedBy) {
      out.blockerKind = 'cross_service';
      out.meta = { blockedByService: blockedBy.slice(0, 120), summary: String(parsed.summary || '').slice(0, 500) };
    }
    return out;
  }
  if (!ok) {
    const reason = final ? `${final.subtype}${final.error ? `: ${final.error}` : ''}` : 'no_result_message';
    log.warn?.('claudeAgent: неуспешный исход', { taskId: task.id, reason });
    return { ok: false, error: reason };
  }

  // PROGRAMMER-USAGE-KPI-001: усвоение токенов/стоимости/cold start прогона — рядом
  // с numTurns в result.agent, чтобы buildCompletionBody прокинул их в тело сдачи
  // (см. контракт tokensIn/... с оркестратором). parsed.summary не трогаем.
  const usage = extractUsage(final);
  const coldStartMs = initAt != null ? initAt - started : null;
  return {
    ok: true,
    model, // VERSION-KPI-TRACKING-001: модель прогона для атрибуции KPI.
    result: {
      summary: (parsed && parsed.summary) || String(final.result || '').slice(0, 4000),
      outcome: 'DONE',
      agent: {
        numTurns: final.num_turns,
        totalCostUsd: final.total_cost_usd,
        terminalReason: final.terminal_reason,
        // Токены/стоимость/cold start прогона для KPI (agent_runs).
        tokensIn: usage.tokensIn,
        tokensInput: usage.tokensInput,
        tokensOut: usage.tokensOut,
        tokensCacheRead: usage.tokensCacheRead,
        tokensCacheCreation: usage.tokensCacheCreation,
        costUsd: usage.costUsd,
        coldStartMs,
      },
      selfReportedFiles: (parsed && (parsed.files_changed || parsed.changedFiles)) || undefined,
    },
  };
}

/**
 * Фабрика исполнителя задачи. Возвращает runAgent(task, {signal}) для
 * ProgrammerRunner. Список изменённых файлов вычисляется драйвером через git, а
 * не берётся из самоотчёта агента.
 *
 * @param {Object} [cfg]
 * @param {Record<string,{cwd:string,env?:Object}>} [cfg.repoMap]
 * @param {string} [cfg.model]
 * @param {number} [cfg.maxTurns]
 * @param {string[]} [cfg.allowedTools]
 * @param {Console} [cfg.log]
 */
export function makeClaudeRunAgent(cfg = {}) {
  const repoMap = cfg.repoMap || loadRepoMap();
  const model = cfg.model || process.env.PROGRAMMER_MODEL || 'claude-opus-4-8';
  const maxTurns = Number(cfg.maxTurns || process.env.PROGRAMMER_MAX_TURNS || 100);
  const allowedTools = cfg.allowedTools || DEFAULT_ALLOWED_TOOLS;
  const log = cfg.log || console;
  // Один менеджер worktree на процесс: держит по одному worktree на микросервис
  // и сериализует задачи внутри сервиса.
  const worktrees = cfg.worktreeManager || new WorktreeManager({ log });

  // Ключ изоляции = микросервис в рамках проекта. Пустой service → общий слот
  // проекта (консервативно сериализуем такие задачи вместе).
  const serviceKeyOf = (task) => `${String(task?.project || '_').trim()}:${String(task?.service || '_default').trim()}`;

  // Задача исполняется в worktree СВОЕГО микросервиса (сериализованно с другими
  // задачами того же сервиса), её дельта применяется в main под глобальным локом;
  // конфликт → задача возвращается в очередь.
  const runAgent = async function runAgent(task, { signal } = {}) {
    const { cwd: repoCwd, env } = resolveRepo(task, repoMap);
    const serviceKey = serviceKeyOf(task);
    // PROGRAMMER-UNIFY-001: модель выбирается движком роли (карточка роли →
    // назначенный коннектор; оркестратор кладёт её в task.model). Это позволяет
    // тестировать один и тот же промт на разных моделях/агентах — версии KPI
    // сравниваются в разрезе модели. Нет назначения → дефолтная модель раннера.
    const effectiveModel =
      typeof task?.model === 'string' && task.model.trim() ? task.model.trim() : model;
    const out = await worktrees.runForService(repoCwd, serviceKey, (worktreeCwd) =>
      runSdkOnce({ cwd: worktreeCwd, env, task, signal, model: effectiveModel, maxTurns, allowedTools, log }));
    // Ветка/коммит worktree программиста нужны стадии GIT_INTEGRATION (влить ветку в
    // main): прокидываем их наверх вместе с остальными полями исхода, ничего не теряя.
    // Нормализуем в null — чтобы ключи всегда были в agentResult (сдача шлёт их и при
    // отсутствии, см. buildCompletionBody).
    return { ...out, branch: out?.branch ?? null, commit: out?.commit ?? null };
  };
  // Доступ к менеджеру (для остановки/чистки из bin).
  runAgent.worktrees = worktrees;
  return runAgent;
}

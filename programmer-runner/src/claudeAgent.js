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
import { buildPrompt, buildRepairPrompt, parseAgentJson } from './promptBuilder.js';
import { WorktreeManager } from './worktreeManager.js';
import {
  DEFAULT_VERIFY_TIMEOUT_MS, detectVerifyCommands, resolveVerifyDir, runVerify,
} from './selfCheck.js';

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
async function runSdkOnce({ cwd, env, task, signal, model, maxTurns, allowedTools, log, prompt: promptOverride }) {
  // promptOverride — ремонтный заход самопроверки (PROGRAMMER-SELF-CHECK-001);
  // без него это обычный первый прогон по описанию задачи.
  const prompt = promptOverride || buildPrompt(task);
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
    // TASK-NEEDS-INPUT-001: агент не стал гадать, а сформулировал вопрос человеку.
    // Это не провал прогона: задачу надо припарковать в NEEDS_INPUT, а не вернуть
    // в очередь на те же грабли. Вопрос без текста игнорируем — парковать задачу
    // с пустым вопросом хуже, чем честно вернуть её в очередь.
    const ni = parsed.needs_input && typeof parsed.needs_input === 'object' ? parsed.needs_input : null;
    const question = ni ? String(ni.question ?? '').trim() : '';
    if (question) {
      out.needsInput = {
        question,
        options: Array.isArray(ni.options)
          ? ni.options.map((o) => String(o ?? '').trim()).filter(Boolean)
          : [],
        context: String(ni.context ?? '').trim() || undefined,
      };
      out.error = `needs_input: ${question}`;
      return out;
    }
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

/** Настройки самопроверки из окружения (PROGRAMMER-SELF-CHECK-001). */
export function selfCheckConfig(env = process.env) {
  const flag = String(env.PROGRAMMER_SELF_CHECK ?? '1').trim();
  const attempts = Number(env.PROGRAMMER_SELF_CHECK_ATTEMPTS ?? 1);
  const timeoutMs = Number(env.PROGRAMMER_VERIFY_TIMEOUT_MS ?? DEFAULT_VERIFY_TIMEOUT_MS);
  return {
    enabled: flag !== '0' && flag.toLowerCase() !== 'false',
    // 0 попыток — проверка только сообщает о красном, ремонтных заходов нет.
    maxAttempts: Number.isFinite(attempts) && attempts >= 0 ? Math.min(attempts, 3) : 1,
    // Baseline можно выключить, если тестовый прогон проекта дорогой: тогда красная
    // проверка НЕ блокирует сдачу (мы не знаем, наша это поломка или чужая).
    baseline: String(env.PROGRAMMER_SELF_CHECK_BASELINE ?? '1').trim() !== '0',
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_VERIFY_TIMEOUT_MS,
  };
}

/**
 * Сложить метрики ремонтных заходов в метрики первого прогона: для KPI важен
 * СУММАРНЫЙ расход на задачу, иначе ремонт выглядит бесплатным.
 */
export function mergeAgentRuns(base, extra) {
  const a = base?.result?.agent || {};
  const b = extra?.result?.agent || {};
  const sum = (x, y) => (Number.isFinite(x) || Number.isFinite(y) ? num(x) + num(y) : undefined);
  return {
    ...base,
    result: {
      ...base.result,
      // Итоговое summary — от последнего (ремонтного) захода, он ближе к правде о
      // состоянии кода; исходное сохраняем рядом, чтобы не потерять суть задачи.
      summary: extra?.result?.summary || base?.result?.summary,
      initialSummary: base?.result?.summary,
      agent: {
        ...a,
        numTurns: sum(a.numTurns, b.numTurns),
        totalCostUsd: sum(a.totalCostUsd, b.totalCostUsd),
        tokensIn: sum(a.tokensIn, b.tokensIn),
        tokensInput: sum(a.tokensInput, b.tokensInput),
        tokensOut: sum(a.tokensOut, b.tokensOut),
        tokensCacheRead: sum(a.tokensCacheRead, b.tokensCacheRead),
        tokensCacheCreation: sum(a.tokensCacheCreation, b.tokensCacheCreation),
        costUsd: sum(a.costUsd, b.costUsd),
        // cold start — характеристика ПЕРВОГО запуска, суммировать бессмысленно.
        coldStartMs: a.coldStartMs,
      },
    },
  };
}

/**
 * PROGRAMMER-SELF-CHECK-001 — прогон агента с замкнутой петлёй проверки:
 *   [baseline] → агент → проверка → (красная? → ремонт → проверка) → исход.
 *
 * Красная проверка блокирует сдачу ТОЛЬКО если baseline был зелёным: иначе мы
 * требовали бы от программиста починить поломки, которые он не вносил.
 */
async function runWithSelfCheck(opts) {
  const { cwd, env, task, signal, log, selfCheck } = opts;
  const verifyDir = resolveVerifyDir(cwd, task);
  const commands = selfCheck.enabled ? detectVerifyCommands(verifyDir) : [];
  const verifyOpts = { commands, cwd: verifyDir, env, signal, timeoutMs: selfCheck.timeoutMs, log };

  // Baseline ДО работы агента: отделяет «я сломал» от «оно и так лежало».
  let baselineOk = null;
  if (commands.length && selfCheck.baseline) {
    const base = await runVerify(verifyOpts);
    baselineOk = base.ok;
    if (!base.ok) {
      log.warn?.('programmer self-check: baseline КРАСНЫЙ — проверка не блокирует сдачу', {
        taskId: task.id, cmd: base.failure?.cmd, exitCode: base.failure?.exitCode,
      });
    }
  }

  let out = await runSdkOnce(opts);
  if (!out.ok) return out;
  if (!commands.length) {
    // Нечего запускать (нет go.mod/скрипта test) — честно помечаем, а не делаем вид,
    // что проверка прошла. Это же видно в KPI: где самопроверка реально работает.
    out.result.verification = { status: selfCheck.enabled ? 'no_commands' : 'disabled', dir: verifyDir };
    return out;
  }

  // Блокирующей проверка считается, когда baseline точно был зелёным.
  const blocking = baselineOk === true;
  let verify = await runVerify(verifyOpts);
  let attempts = 0;

  while (!verify.ok && attempts < selfCheck.maxAttempts && !signal?.aborted) {
    attempts += 1;
    log.warn?.('programmer self-check: проверка красная — ремонтный заход', {
      taskId: task.id, attempt: attempts, cmd: verify.failure?.cmd, exitCode: verify.failure?.exitCode,
    });
    const repair = await runSdkOnce({
      ...opts,
      prompt: buildRepairPrompt(task, verify.failure, { attempt: attempts, maxAttempts: selfCheck.maxAttempts }),
    });
    // Ремонт не удался сам по себе (краш/лимит ходов) — не топим задачу: оставляем
    // исход первого прогона и даём проверке вынести вердикт ниже.
    if (repair.ok) out = mergeAgentRuns(out, repair);
    else log.warn?.('programmer self-check: ремонтный заход не удался', { taskId: task.id, error: repair.error });
    verify = await runVerify(verifyOpts);
  }

  out.result.verification = {
    status: verify.ok ? 'passed' : (blocking ? 'failed' : 'failed_not_blocking'),
    commands,
    dir: verifyDir,
    repairAttempts: attempts,
    baseline: baselineOk === null ? 'skipped' : (baselineOk ? 'green' : 'red'),
    failure: verify.ok ? undefined : {
      cmd: verify.failure?.cmd,
      exitCode: verify.failure?.exitCode ?? null,
      timedOut: verify.failure?.timedOut,
      output: verify.failure?.output,
    },
  };

  if (verify.ok) {
    log.info?.('programmer self-check: зелено', { taskId: task.id, repairAttempts: attempts });
    return out;
  }
  if (!blocking) {
    // Красное, но baseline тоже был красным (или не мерился) — сдаём с отметкой:
    // блокировать нельзя, иначе один сломанный проект заклинит все свои задачи.
    log.warn?.('programmer self-check: красная проверка, сдаём с отметкой (baseline не зелёный)', {
      taskId: task.id, cmd: verify.failure?.cmd,
    });
    return out;
  }
  // Проверка была зелёной до нас и красная после — это наша поломка. Возвращаем
  // задачу в очередь: сдавать заведомо красный код дальше по конвейеру нельзя.
  log.error?.('programmer self-check: сдача заблокирована — проверка красная после правок', {
    taskId: task.id, cmd: verify.failure?.cmd, exitCode: verify.failure?.exitCode, repairAttempts: attempts,
  });
  return {
    ok: false,
    error: `self_check_failed: ${verify.failure?.cmd || 'verify'} → exit ${verify.failure?.exitCode ?? 'timeout'}`,
    meta: {
      selfCheck: out.result.verification,
      summary: String(out.result?.summary || '').slice(0, 500),
    },
    result: out.result,
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
  // PROGRAMMER-SELF-CHECK-001: политика самопроверки на процесс (env читаем один раз).
  const selfCheck = cfg.selfCheck || selfCheckConfig();
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
      runWithSelfCheck({
        cwd: worktreeCwd, env, task, signal, model: effectiveModel, maxTurns, allowedTools, log, selfCheck,
      }));
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

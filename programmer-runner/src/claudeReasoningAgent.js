// ROLE-ENGINE-ROUTING-001 — обёртка над Claude Agent SDK для РАССУЖДАЮЩИХ ролей
// (Приёмщик/Архитектор/Декомпозитор и пр.), назначенных движку 'claude_code'.
// В отличие от claudeAgent.js (роль PROGRAMMER: правит код, git-diff, worktree),
// здесь роль только ЧИТАЕТ и РАССУЖДАЕТ: запускаем headless Claude в корне проекта
// с read-only инструментами и возвращаем финальный текст — оркестратор разбирает
// его в вердикт (parseVerdict) тем же путём, что и DeepSeek/Codex.
//
// Промпт (system+user роли) и требование строгого JSON-вердикта собирает
// оркестратор и отдаёт в claim — драйвер «тупой», роль и требования приходят снаружи.
//
// OBSERVABILITY-REASONING-001 — пофазная наблюдаемость прогона. Один прогон проходит
// фазы: coldStart (от вызова query() до первого system/init сообщения SDK — тот самый
// ~21с спавна нативного модуля + авторизация подписки + hooks) и reason (от init до
// result — собственно многоходовое рассуждение с tool-loop). Снимаем тайминги, число
// ходов/тулзов, токены и КЛАССИФИЦИРУЕМ исход, чтобы по логу отличать «думает и не
// успевает» (working_slow) от «висит и ничего не делает» (stuck_no_response/coldstart_failed).
import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';

// Рассуждающим ролям достаточно чтения: смотрят код/доки и выносят вердикт.
const READONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'];

// Порог «нормального» холодного старта: дольше — это аномалия, которую надо видеть.
const COLDSTART_WARN_MS = Number(process.env.CLAUDE_REASONING_COLDSTART_WARN_MS || 10000);
// «Активность была недавно» — если до обрыва от последнего сообщения прошло меньше
// этого, агент реально работал (думает и не успел), иначе — затих в середине.
const STALL_GAP_MS = Number(process.env.CLAUDE_REASONING_STALL_GAP_MS || 30000);

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

// Токены/стоимость из финального result-сообщения SDK. ВАЖНО: result.usage —
// контекст ПОСЛЕДНЕГО хода (не сумма), поэтому для KPI берём result.modelUsage —
// КУМУЛЯТИВНЫЕ по моделям итоги за всю сессию (сходятся с total_cost_usd). Фолбэк на
// usage, если modelUsage нет (старые версии SDK).
function extractUsage(final) {
  const costUsd = num(final?.total_cost_usd);
  const mu = final?.modelUsage;
  if (mu && typeof mu === 'object') {
    let tokensIn = 0;
    let tokensOut = 0;
    for (const m of Object.values(mu)) {
      tokensIn += num(m?.inputTokens) + num(m?.cacheCreationInputTokens) + num(m?.cacheReadInputTokens);
      tokensOut += num(m?.outputTokens);
    }
    return { tokensIn, tokensOut, costUsd };
  }
  const u = final?.usage || {};
  const tokensIn = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
  const tokensOut = num(u.output_tokens);
  return { tokensIn, tokensOut, costUsd };
}

/**
 * Фабрика исполнителя рассуждающей роли через Claude. Возвращает
 * runAgent(task, {signal}) для ReasoningRunner.
 * @param {Object} [cfg]
 * @param {string} [cfg.model]
 * @param {number} [cfg.maxTurns]
 * @param {Console} [cfg.log]
 */
export function makeClaudeReasoningRunAgent(cfg = {}) {
  const model = cfg.model || process.env.CLAUDE_REASONING_MODEL || 'claude-sonnet-4-6';
  // RESEARCH-BUDGET-001: кап на глубину разведки. Разведка должна укладываться в
  // ~2 прохода на карты проекта/сервиса (подаются инлайн) + точечное чтение
  // релевантных файлов. 12 ходов — сознательно жёсткий потолок: упор в него = роль
  // плохо нарезана или ходит по всему репозиторию (см. исход max_turns_exceeded).
  const maxTurns = Number(cfg.maxTurns || process.env.CLAUDE_REASONING_MAX_TURNS || 12);
  const allowedTools = cfg.allowedTools || READONLY_TOOLS;
  const log = cfg.log || console;
  const queryImpl = cfg.query || query;

  return async function runAgent(task, { signal } = {}) {
    const started = Date.now();
    // То же, что видит DeepSeek/Codex: system-промпт роли + контекст задачи + строгое
    // требование JSON-вердикта (всё собрано оркестратором в claim).
    // PROMPT-CACHE-001: если оркестратор пометил cachePrefix — держим СТАТИЧНУЮ часть
    // (промт роли + карта проекта) как system-префикс с кэш-границей
    // (SYSTEM_PROMPT_DYNAMIC_BOUNDARY): драйвер кэширует её (5-мин ephemeral), и
    // повторные прогоны того же проекта/роли не переоплачивают карту. Динамику задачи
    // шлём как user-сообщение. Иначе — прежнее склеенное поведение (одна строка).
    const sys = String(task.systemPrompt || '');
    const user = String(task.userPrompt || '');
    const useCachePrefix = task.cachePrefix === true && sys !== '';
    const prompt = useCachePrefix ? user : `${sys}\n\n${user}`.trim();
    const systemPromptOpt = useCachePrefix ? [sys, SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : undefined;
    const ac = linkSignal(signal);
    const cwd = String(task.projectPath || '').trim();

    // Пофазные метрики прогона.
    let initAt = null;        // момент первого system/init → конец холодного старта
    let lastMsgAt = started;  // момент последнего любого сообщения (для gap при обрыве)
    let turns = 0;            // ответы ассистента
    let toolUses = 0;         // вызовы инструментов
    let rateLimited = false;  // упёрлись в лимит подписки
    let final = null;

    // Метрики, которые отдаём наверх в ЛЮБОМ исходе (успех/abort/throw).
    const metrics = () => {
      const coldStartMs = initAt != null ? initAt - started : null;
      const reasonMs = initAt != null ? Date.now() - initAt : null;
      const usage = extractUsage(final);
      // KPI ходов берём из result.num_turns (авторитетный счётчик SDK), а ручной
      // счётчик assistant-сообщений — фолбэк, если result не пришёл (abort/throw).
      const turnsKpi = num(final?.num_turns) || turns;
      return {
        coldStartMs, reasonMs, turns: turnsKpi, toolUses, rateLimited,
        tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costUsd: usage.costUsd,
        durationMs: Date.now() - started,
        model, // VERSION-KPI-TRACKING-001: модель прогона для атрибуции KPI.
      };
    };

    try {
      for await (const message of queryImpl({
        prompt,
        options: {
          ...(cwd ? { cwd } : {}),
          ...(systemPromptOpt ? { systemPrompt: systemPromptOpt } : {}),
          model,
          maxTurns,
          permissionMode: 'bypassPermissions',
          allowedTools,
          // COLDSTART-MCP-ISOLATION-001: рассуждающим ролям нужны только встроенные
          // Read/Glob/Grep/Bash. По умолчанию SDK грузит ВСЕ источники настроек
          // (проектный .mcp.json, ~/.claude, хуки) и на каждом спавне поднимает MCP-
          // серверы проекта (у ai-dev-manager — ai-dev-manager+magic+tools-service) →
          // это ~20с холодного старта, а их tool-схемы раздувают контекст каждый ход
          // (лишние токены). Полная изоляция: без внешних настроек и MCP.
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          abortController: ac,
          env: { ...process.env },
        },
      })) {
        lastMsgAt = Date.now();
        if (message.type === 'system' && initAt == null) {
          // Первый признак, что SDK поднялся (hook_started/hook_response/init) —
          // фиксируем конец холодного старта по самому первому system-сообщению.
          initAt = Date.now();
          const coldStartMs = initAt - started;
          if (coldStartMs > COLDSTART_WARN_MS) {
            log.warn?.('claudeReasoningAgent: долгий холодный старт', { taskId: task.id, coldStartMs });
          }
        }
        if (message.type === 'assistant') {
          turns += 1;
          const blocks = message.message?.content;
          if (Array.isArray(blocks)) toolUses += blocks.filter((b) => b?.type === 'tool_use').length;
        }
        if (message.type === 'rate_limit_event') rateLimited = true;
        if (message.type === 'result') final = message;
      }
    } catch (error) {
      if (ac.signal.aborted) {
        return { ok: false, error: 'agent_aborted', outcome: classifyAbort(initAt, turns, lastMsgAt), ...metrics() };
      }
      return { ok: false, error: `agent_threw: ${error.message}`, outcome: 'threw', ...metrics() };
    }

    if (ac.signal.aborted) {
      return { ok: false, error: 'agent_aborted', outcome: classifyAbort(initAt, turns, lastMsgAt), ...metrics() };
    }
    // RESEARCH-BUDGET-001: упор в лимит ходов — ОТДЕЛЬНЫЙ помеченный исход (как у
    // claudeAgent.js программиста), а не безликий claude_failed. Сигнал, что роль
    // ходит по всему репозиторию вместо двухуровневой карты → видно в KPI.
    if (final && final.subtype === 'error_max_turns') {
      log.warn?.('claudeReasoningAgent: упор в лимит ходов', { taskId: task.id, numTurns: final.num_turns, maxTurns });
      return { ok: false, error: 'max_turns_exceeded', outcome: 'max_turns_exceeded', ...metrics() };
    }

    const ok = !!final && final.subtype === 'success' && final.is_error !== true;
    if (!ok) {
      const reason = final ? `${final.subtype}${final.error ? `: ${final.error}` : ''}` : 'no_result_message';
      log.warn?.('claudeReasoningAgent: неуспешный исход', { taskId: task.id, reason });
      return { ok: false, error: `claude_failed: ${reason}`, outcome: `failed:${final?.subtype || 'no_result'}`, ...metrics() };
    }
    const response = String(final.result || '').trim();
    if (!response) return { ok: false, error: 'empty_claude_output', outcome: 'empty_output', ...metrics() };
    // Вердикт отдаём как сырой текст: оркестратор распарсит его толерантно
    // (parseVerdict) — у Claude SDK нет навязывания JSON-схемы, как у codex.
    return { ok: true, response, outcome: 'success', ...metrics() };
  };
}

// Классификация обрыва (abort по таймауту): различаем «вообще не поднялся»,
// «поднялся, но ничего не выдал» и «работал, не успел / затих в середине».
export function classifyAbort(initAt, turns, lastMsgAt, now = Date.now()) {
  if (initAt == null) return 'coldstart_failed';
  if (turns === 0) return 'stuck_no_response';
  return (now - lastMsgAt) <= STALL_GAP_MS ? 'working_slow' : 'stalled_midway';
}

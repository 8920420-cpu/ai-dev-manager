// ROLE-ENGINE-ROUTING-001 — обёртка над Claude Agent SDK для РАССУЖДАЮЩИХ ролей
// (Приёмщик/Архитектор/Декомпозитор и пр.), назначенных движку 'claude_code'.
// В отличие от claudeAgent.js (роль PROGRAMMER: правит код, git-diff, worktree),
// здесь роль только ЧИТАЕТ и РАССУЖДАЕТ: запускаем headless Claude в корне проекта
// с read-only инструментами и возвращаем финальный текст — оркестратор разбирает
// его в вердикт (parseVerdict) тем же путём, что и DeepSeek/Codex.
//
// Промпт (system+user роли) и требование строгого JSON-вердикта собирает
// оркестратор и отдаёт в claim — драйвер «тупой», роль и требования приходят снаружи.
import { query } from '@anthropic-ai/claude-agent-sdk';

// Рассуждающим ролям достаточно чтения: смотрят код/доки и выносят вердикт.
const READONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'];

function linkSignal(signal) {
  const ac = new AbortController();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  return ac;
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
  const maxTurns = Number(cfg.maxTurns || process.env.CLAUDE_REASONING_MAX_TURNS || 24);
  const allowedTools = cfg.allowedTools || READONLY_TOOLS;
  const log = cfg.log || console;
  const queryImpl = cfg.query || query;

  return async function runAgent(task, { signal } = {}) {
    const started = Date.now();
    // То же, что видит DeepSeek/Codex: system-промпт роли + контекст задачи + строгое
    // требование JSON-вердикта (всё собрано оркестратором в claim).
    const prompt = `${String(task.systemPrompt || '')}\n\n${String(task.userPrompt || '')}`.trim();
    const ac = linkSignal(signal);
    const cwd = String(task.projectPath || '').trim();

    let final = null;
    try {
      for await (const message of queryImpl({
        prompt,
        options: {
          ...(cwd ? { cwd } : {}),
          model,
          maxTurns,
          permissionMode: 'bypassPermissions',
          allowedTools,
          abortController: ac,
          env: { ...process.env },
        },
      })) {
        if (message.type === 'result') final = message;
      }
    } catch (error) {
      if (ac.signal.aborted) return { ok: false, error: 'agent_aborted' };
      return { ok: false, error: `agent_threw: ${error.message}` };
    }

    if (ac.signal.aborted) return { ok: false, error: 'agent_aborted' };
    const ok = !!final && final.subtype === 'success' && final.is_error !== true;
    if (!ok) {
      const reason = final ? `${final.subtype}${final.error ? `: ${final.error}` : ''}` : 'no_result_message';
      log.warn?.('claudeReasoningAgent: неуспешный исход', { taskId: task.id, reason });
      return { ok: false, error: `claude_failed: ${reason}` };
    }
    const response = String(final.result || '').trim();
    if (!response) return { ok: false, error: 'empty_claude_output' };
    // Вердикт отдаём как сырой текст: оркестратор распарсит его толерантно
    // (parseVerdict) — у Claude SDK нет навязывания JSON-схемы, как у codex.
    return { ok: true, response, durationMs: Date.now() - started };
  };
}

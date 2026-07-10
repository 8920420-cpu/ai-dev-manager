// CODEX-REASONING-001 — обёртка над `codex exec`: запускает headless Codex CLI на
// рассуждающей роли (Приёмщик/Архитектор/Декомпозитор…) в корне реального проекта
// и возвращает машинно-читаемый вердикт. Это «грязный край» сервиса (реальный
// дочерний процесс + ФС), по аналогии с programmer-runner/src/claudeAgent.js:
// юнит-тестами покрыт инъектируемый ReasoningRunner, а сам spawn — нет.
//
// Почему хостовый процесс, а не HTTP-коннектор: оркестратор живёт в Linux-
// контейнере и не может ни запустить локальный `codex`, ни увидеть подписку
// ChatGPT (~/.codex/auth.json). Codex берёт авторизацию из CODEX_HOME сам —
// токен-мост (как у Claude) не нужен.
//
// Контракт с оркестратором: claim отдаёт ГОТОВЫЙ промпт (system+user роли) и
// JSON-схему вердикта; здесь мы только гоняем модель и читаем результат. Разбор
// вердикта и переход делает оркестратор (applyReasoningVerdict).
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Имя бинарника Codex (в PATH). На Windows это codex.cmd/exe — shell:true разрулит.
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
// Песочница: рассуждающие роли только читают → read-only (безопасно). Для ролей,
// которые пишут (напр. Documentation Keeper), задайте workspace-write.
const CODEX_SANDBOX = process.env.CODEX_SANDBOX || 'read-only';
// COLDSTART-MCP-ISOLATION-001 / медленный spawn на Windows: каждая read-команда
// модели — это отдельный процесс, а песочница (`[windows] sandbox="elevated"` в
// config.toml) оборачивает его в restricted-token launch. На Windows spawn ~50–75 мс
// (+ Defender real-time scan), и серия мелких чтений выбивает внутренний таймаут
// codex → модель жалуется «команды чтения на диске медленные, упёрлись в таймаут».
// Для ДОВЕРЕННЫХ локальных проектов и read-only ролей песочница — чистый оверхед:
// флагом можно её обойти (codex считает, что окружение изолировано снаружи).
// По умолчанию ВЫКЛ — поведение не меняется. Включать осознанно (раннер на хосте,
// проект помечен trusted в ~/.codex/config.toml).
const CODEX_BYPASS_SANDBOX = /^(1|true|yes|on)$/i.test(String(process.env.CODEX_BYPASS_SANDBOX || '').trim());
// Модель: по умолчанию пусто → Codex берёт модель из своего config.toml.
const CODEX_MODEL = process.env.CODEX_MODEL || '';

// Достаём человекочитаемую причину сбоя из JSONL-хвоста stdout codex. Когда
// бэкенд ChatGPT/Codex отвечает ошибкой (400 invalid_schema, 429, 502/503), codex
// часто пишет её НЕ в stderr, а событием turn.failed/error в stdout — без этого в
// логах оставалось слепое exit_N. Сканируем хвост с конца, берём первое сообщение.
function extractCodexError(stdoutTail) {
  const lines = String(stdoutTail || '').split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let ev;
    try { ev = JSON.parse(lines[i]); } catch { continue; }
    const msg = ev?.error?.message ?? ev?.error ?? (ev?.type === 'turn.failed' ? ev?.message : null);
    if (msg) return (typeof msg === 'string' ? msg : JSON.stringify(msg)).replace(/\s+/g, ' ').slice(0, 400);
  }
  return '';
}

// Связать внешний AbortSignal с убийством процесса.
function linkAbort(child, signal) {
  if (!signal) return () => {};
  const onAbort = () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener?.('abort', onAbort);
}

/**
 * Один прогон `codex exec` на задаче рассуждающей роли.
 * @param {Object} task  захваченная reasoning-задача (см. claimNextReasoningTask)
 * @param {{signal?:AbortSignal}} [ctx]
 * @returns {Promise<{ok:boolean, verdict?:object, response?:string, durationMs?:number, error?:string}>}
 */
export function makeCodexRunAgent(cfg = {}) {
  const bin = cfg.bin || CODEX_BIN;
  const sandbox = cfg.sandbox || CODEX_SANDBOX;
  const bypassSandbox = cfg.bypassSandbox ?? CODEX_BYPASS_SANDBOX;
  const model = cfg.model ?? CODEX_MODEL;
  const log = cfg.log || console;
  const spawnImpl = cfg.spawn || spawn;

  async function runAgent(task, { signal } = {}) {
    const started = Date.now();
    // Временные файлы прогона: схема вердикта и файл последнего сообщения агента.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-run-'));
    const schemaFile = path.join(dir, 'schema.json');
    const lastMsgFile = path.join(dir, 'last.json');
    const cleanup = async () => { try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ } };

    try {
      await fs.writeFile(schemaFile, JSON.stringify(task.outputSchema ?? {}, null, 2));

      // Codex exec принимает один промпт (stdin). Склеиваем system+user роли — это
      // ровно то, что в DeepSeek-пути уходит как messages[system,user].
      const prompt = `${String(task.systemPrompt || '')}\n\n${String(task.userPrompt || '')}`.trim();

      // `--dangerously-bypass-...` и `-s` взаимоисключающи: bypass снимает песочницу
      // целиком (без per-command restricted-token spawn), -s выбирает её политику.
      const sandboxArgs = bypassSandbox
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['-s', sandbox];
      const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check',
        ...sandboxArgs, '--output-schema', schemaFile, '-o', lastMsgFile];
      if (model) args.push('-m', model);
      // Рабочий корень задаём через cwd процесса, а НЕ через аргумент `-C`: на
      // Windows codex — это codex.cmd (нужен shell:true), а пути проектов содержат
      // кириллицу/пробелы, которые shell:true не экранирует (DEP0190). cwd spawn
      // передаётся ОС напрямую, без шелл-кавычек — codex без `-C` берёт его как корень.
      const cwd = String(task.projectPath || '').trim() || dir;
      // Если у схемы есть поле output, codex навяжет форму ответа; финал — в lastMsgFile.
      args.push('-'); // промпт из stdin

      const out = await new Promise((resolve) => {
        let proc;
        try {
          proc = spawnImpl(bin, args, { cwd, shell: process.platform === 'win32', windowsHide: true });
        } catch (e) {
          return resolve({ code: -1, err: `spawn_failed: ${e.message}` });
        }
        let stderr = '';
        let stdoutTail = '';
        const unlink = linkAbort(proc, signal);
        proc.stdout?.setEncoding('utf8');
        proc.stderr?.setEncoding('utf8');
        // Финал берём из lastMsgFile, но при сбое реальная причина приходит
        // JSONL-событием в stdout — храним только хвост (8 КБ), чтобы извлечь её и
        // не забить буфер на длинных прогонах.
        proc.stdout?.on('data', (c) => { stdoutTail = (stdoutTail + c).slice(-8000); });
        proc.stderr?.on('data', (c) => { stderr += c; });
        proc.on('error', (e) => { unlink(); resolve({ code: -1, err: e.message, stdoutTail }); });
        proc.on('close', (code) => { unlink(); resolve({ code, err: stderr, stdoutTail }); });
        proc.stdin?.write(prompt);
        proc.stdin?.end();
      });

      if (signal?.aborted) return { ok: false, error: 'agent_aborted' };

      // Финальный вердикт пишет codex в lastMsgFile (валидный JSON по схеме).
      let raw = '';
      try { raw = await fs.readFile(lastMsgFile, 'utf8'); } catch { /* нет файла */ }
      raw = String(raw || '').trim();

      if (out.code !== 0 && !raw) {
        const detail = (out.err && out.err.trim()) || extractCodexError(out.stdoutTail) || `exit_${out.code}`;
        const reason = detail.toString().trim().slice(0, 400);
        log.warn?.('codexAgent: codex exec завершился неуспехом', { taskId: task.id, code: out.code, reason });
        return { ok: false, error: `codex_failed: ${reason}` };
      }

      let verdict = null;
      try { verdict = JSON.parse(raw); } catch { /* отдадим как сырой текст */ }
      const durationMs = Date.now() - started;

      if (verdict && typeof verdict === 'object' && !Array.isArray(verdict)) {
        return { ok: true, verdict, response: raw, durationMs, model };
      }
      // Схема должна была гарантировать JSON; если нет — отдадим текст, оркестратор
      // распарсит толерантно (parseVerdict) либо пометит verdict_unparsed.
      if (raw) return { ok: true, response: raw, durationMs, model };
      return { ok: false, error: 'empty_codex_output' };
    } catch (e) {
      return { ok: false, error: `agent_threw: ${e.message}` };
    } finally {
      await cleanup();
    }
  }

  return runAgent;
}

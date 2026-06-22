// Движок авто-ролей: превращает auto-роль из ROLE_FLOW в реальный вызов ИИ.
// Для роли загружается её промт (roles/<role>.md) как system, собирается
// контекст задачи, вызывается коннектор (DeepSeek/OpenAI-совместимый) в
// JSON-режиме, ответ нормализуется в вердикт и по нему решается переход.
//
// Здесь только «мышление» роли и чистые функции решения. Запись в БД и сами
// переходы делает db.js (advanceOne), чтобы держать сетевой вызов вне
// транзакции. Чистые функции (parseVerdict/normalizeVerdict/decideTransition)
// покрыты юнит-тестами без сети и без Postgres.
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE_FLOW } from './rolePipeline.js';
import { invoke as llmInvoke } from './llmConnector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// В контейнере промты лежат в /app/roles (Dockerfile COPY + ENV ROLES_DIR);
// при локальном запуске node — в корне репозитория (../../../roles).
export const ROLES_DIR = process.env.ROLES_DIR || resolve(__dirname, '../../../roles');

// Сколько раз задача может вернуться в CODING через провал ревью/анализа,
// прежде чем мы остановимся и пометим BLOCKED (защита от бесконечной траты).
export const MAX_REWORK = Number(process.env.RUNNER_MAX_REWORK || 3);

// Код роли -> файл промта в roles/. Роли без файла (PIPELINE_SERVICE,
// GIT_INTEGRATOR) обслуживает host-мост, а не ИИ-движок.
export const ROLE_PROMPT_FILES = {
  ARCHITECT: 'architect.md',
  DECOMPOSER: 'decomposer.md',
  TASK_REVIEWER: 'reviewer.md',
  FAILURE_ANALYST: 'failure-analyst.md',
  DOCUMENTATION_AUDITOR: 'documentation-auditor.md',
  DOCUMENTATION_KEEPER: 'documentation-keeper.md',
};

// Роли, которые ИИ-движок исполняет «рассуждением» (есть промт).
export const LLM_ROLE_CODES = Object.keys(ROLE_PROMPT_FILES);

// Роли реального действия — их выполняет host-мост (docker/git), не ИИ.
export const HOST_ROLE_CODES = ['PIPELINE_SERVICE', 'GIT_INTEGRATOR'];

const SUCCESS_STATUSES = new Set([
  'APPROVED', 'READY', 'DONE', 'DIAGNOSED', 'PASS', 'OK', 'SUCCESS',
  'COMPLETED', 'READY_FOR_REVIEW', 'AUDITED', 'UPDATED', 'PROCEED',
]);
const FAILURE_STATUSES = new Set([
  'NEEDS_FIX', 'REJECTED', 'BLOCKED', 'FAILED', 'FAIL', 'INCONCLUSIVE',
  'INFRASTRUCTURE_BLOCKED', 'ERROR',
]);

// Сжать прошлые успешные прогоны ролей в компактный список для контекста
// следующей роли: code + статус-вердикт + summary + ключевые findings. Полный
// текст ответа в контекст не тащим (он есть в prompt_exchanges) — только суть.
export function summarizePriorRuns(rows = []) {
  return rows
    .filter((r) => r && r.role_code)
    .map((r) => {
      const o = r.output_json && typeof r.output_json === 'object' ? r.output_json : {};
      return {
        role: r.role_code,
        status: String(o.status ?? r.status ?? '').trim(),
        summary: typeof o.summary === 'string' ? o.summary : '',
        findings: Array.isArray(o.findings) ? o.findings.slice(0, 8).map(String) : [],
      };
    });
}

export async function loadRolePrompt(roleCode, { dir = ROLES_DIR } = {}) {
  const file = ROLE_PROMPT_FILES[roleCode];
  if (!file) throw new Error(`no prompt file for role ${roleCode}`);
  return readFile(join(dir, file), 'utf8');
}

// Единый JSON-контракт вердикта, дописывается к промту роли. Коннектор уже в
// JSON-режиме, но просим явный обязательный JSON, иначе DeepSeek может отдать
// прозу. Поля совпадают с YAML-форматами промтов, плюс ok-нормализация.
export function buildVerdictInstruction() {
  return [
    'Верни ОТВЕТ СТРОГО как JSON-объект (valid json), без markdown и текста вокруг.',
    'Структура: {',
    '  "status": "<статус из раздела «Формат результата» твоей роли>",',
    '  "summary": "<краткий вывод на русском>",',
    '  "next_role": "<код следующей роли или DONE/USER>",',
    '  "findings": ["<ключевые замечания, если есть>"]',
    '}',
    'status обязателен и должен точно соответствовать допустимым статусам роли.',
  ].join('\n');
}

// Пользовательский payload: компактный контекст задачи + требование вердикта.
export function buildUserPayload(roleCode, context) {
  return [
    `Задача роли ${roleCode}. Контекст задачи (JSON):`,
    JSON.stringify(context, null, 2),
    '',
    buildVerdictInstruction(),
  ].join('\n');
}

// Толерантный парсинг: ответ может быть чистым JSON, JSON в ```-блоке или
// JSON с мусором вокруг. Возвращает объект или null.
export function parseVerdict(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return null;
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  let v = tryParse(raw);
  if (v) return v;
  // Вырезать ```json ... ``` или первый {...} блок.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    v = tryParse(fence[1].trim());
    if (v) return v;
  }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) {
    v = tryParse(raw.slice(first, last + 1));
    if (v) return v;
  }
  return null;
}

// Нормализация вердикта роли в { ok, status, summary, nextRoleHint, findings }.
// ok=null означает «не удалось определить» — вызывающий решает консервативно.
export function normalizeVerdict(roleCode, parsed) {
  if (!parsed) return { ok: null, status: '', summary: '', nextRoleHint: '', findings: [] };
  const status = String(parsed.status ?? '').trim().toUpperCase();
  const summary = String(parsed.summary ?? '').trim();
  const nextRoleHint = String(parsed.next_role ?? parsed.nextRole ?? '').trim().toUpperCase();
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map((f) => (typeof f === 'string' ? f : JSON.stringify(f)))
    : [];
  let ok = null;
  if (SUCCESS_STATUSES.has(status)) ok = true;
  else if (FAILURE_STATUSES.has(status)) ok = false;
  return { ok, status, summary, nextRoleHint, findings };
}

// Чистое решение о переходе по вердикту. Не трогает БД.
// reworkCount — сколько раз задача уже возвращалась в CODING (защита от цикла).
// Возвращает { toStatus, nextRole, done, blocked, agentRunStatus, reason }.
export function decideTransition(roleCode, verdict, { reworkCount = 0, maxRework = MAX_REWORK } = {}) {
  const flow = ROLE_FLOW[roleCode];
  if (!flow) return { blocked: true, agentRunStatus: 'FAILED', reason: 'unknown_role' };

  const proceed = () => ({
    toStatus: flow.to,
    nextRole: flow.next,
    done: flow.next === null,
    blocked: false,
    agentRunStatus: 'SUCCESS',
    reason: 'ok',
  });
  const block = (reason) => ({
    toStatus: 'BLOCKED',
    nextRole: null,
    done: false,
    blocked: true,
    agentRunStatus: 'FAILED',
    reason,
  });
  const toAnalyst = () => ({
    toStatus: 'FAILURE_ANALYSIS',
    nextRole: 'FAILURE_ANALYST',
    done: false,
    blocked: false,
    agentRunStatus: 'SUCCESS',
    reason: 'review_failed',
  });

  switch (roleCode) {
    case 'TASK_REVIEWER':
      // Гейт качества: проходим только при явном APPROVED. Любой не-успех
      // (включая неразобранный вердикт) — на анализ причины.
      if (verdict.ok === true) return proceed();
      if (reworkCount >= maxRework) return block('max_rework_exceeded');
      return toAnalyst();
    case 'FAILURE_ANALYST':
      // Диагност всегда возвращает работу Programmer, кроме явного тупика.
      if (verdict.ok === false && ['INCONCLUSIVE', 'INFRASTRUCTURE_BLOCKED'].includes(verdict.status)) {
        return block(verdict.status.toLowerCase());
      }
      if (reworkCount >= maxRework) return block('max_rework_exceeded');
      return proceed();
    case 'ARCHITECT':
    case 'DECOMPOSER':
      // Проектные роли: BLOCKED => остановка на пользователя, иначе вперёд.
      if (verdict.ok === false) return block(verdict.status.toLowerCase() || 'blocked');
      return proceed();
    case 'DOCUMENTATION_AUDITOR':
    case 'DOCUMENTATION_KEEPER':
      // Документация не гейт корректности: при любом разборчивом ответе идём
      // дальше; только явный BLOCKED останавливает.
      if (verdict.status === 'BLOCKED') return block('docs_blocked');
      return proceed();
    default:
      return verdict.ok === false ? block('role_failed') : proceed();
  }
}

// --- Сетевой слой (вне транзакции) -----------------------------------------

// Выбрать включённый коннектор с токеном. Предпочтение: точное совпадение
// consumer_service, затем пустой consumer_service, затем по priority.
export async function pickConnectorRow(client, consumerService = '') {
  const r = await client.query(
    `SELECT id, name, provider, endpoint, access_token, model, consumer_service, priority
       FROM connectors
      WHERE is_enabled = true AND access_token <> ''
      ORDER BY (consumer_service = $1) DESC, (consumer_service = '') DESC, priority ASC, lower(name) ASC
      LIMIT 1`,
    [consumerService],
  );
  return r.rows[0] ?? null;
}

function rowToConn(row) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    endpoint: row.endpoint,
    accessToken: row.access_token,
    model: row.model,
    consumerService: row.consumer_service,
  };
}

/**
 * Выполнить «мышление» роли: вызвать ИИ и вернуть нормализованный вердикт.
 * Журналирует обмен в prompt_exchanges (is_manual=false). НЕ делает переходов.
 * Бросает при отсутствии коннектора/промта или сетевой ошибке — вызывающий
 * трактует это как провал шага роли.
 *
 * @returns {{ verdict, response, promptText, connectorId, exchangeId, durationMs }}
 */
export async function runReasoningRole(client, { roleCode, context }, { dir = ROLES_DIR } = {}) {
  const system = await loadRolePrompt(roleCode, { dir });
  const user = buildUserPayload(roleCode, context);
  const row = await pickConnectorRow(client, `runner:${roleCode}`);
  if (!row) {
    const e = new Error('no_enabled_connector');
    e.code = 'NO_CONNECTOR';
    throw e;
  }
  const conn = rowToConn(row);

  const promptText = `${system}\n\n${user}`;
  const ins = await client.query(
    `INSERT INTO prompt_exchanges (connector_id, consumer_service, prompt, status, is_manual)
     VALUES ($1, $2, $3, 'отправлен', false) RETURNING id`,
    [conn.id, `runner:${roleCode}`, promptText],
  );
  const exchangeId = ins.rows[0].id;

  try {
    const { text, httpStatus, durationMs } = await llmInvoke(conn, { system, user });
    await client.query(
      `UPDATE prompt_exchanges SET response = $2, status = 'завершен', http_status = $3, duration_ms = $4
        WHERE id = $1`,
      [exchangeId, text, httpStatus ?? null, durationMs ?? null],
    );
    const verdict = normalizeVerdict(roleCode, parseVerdict(text));
    return { verdict, response: text, promptText, connectorId: conn.id, exchangeId, durationMs };
  } catch (e) {
    await client.query(
      `UPDATE prompt_exchanges SET status = 'ошибка', error = $2, http_status = $3, duration_ms = $4
        WHERE id = $1`,
      [exchangeId, e.message, e.httpStatus ?? null, e.durationMs ?? null],
    );
    throw e;
  }
}

// Реестр решений (decision ledger) — best-effort стор архитектурных решений в ClickHouse.
//
// Источники: ADR-журнал `DECISIONS.md` (принятые решения + отвергнутые альтернативы)
// и `git log --oneline` (фактические изменения как «решения кода»). Postgres/ClickHouse
// НЕ являются истиной для решений — истина в DECISIONS.md и git; здесь мы строим быстрый
// поисковый стор «уже решали / уже отвергали», чтобы не переигрывать одни и те же вопросы.
//
// Как и observability-стор: недоступность ClickHouse НЕ должна ломать оркестратор —
// гейт clickhouseEnabled() + try/catch на каждом внешнем вызове; схема самолечится.
// Чистые парсеры (normalizeSignature/parseDecisionsMarkdown/parseGitLogDecisions/decisionRow)
// не зависят от ClickHouse и покрыты юнит-тестами.

import {
  clickhouseEnabled,
  clickhouseCommand,
  clickhouseInsertJSONEachRow,
  isMissingSchemaError,
} from './clickhouseClient.js';
import { createLogger } from '../../../shared/logging/index.js';

const log = createLogger({ service: 'orchestrator-service' });

// ── Стоп-слова (RU+EN) для сигнатур проблемы ────────────────────────────────────
// Значимость токена = длина >= 3 И не стоп-слово. Короткие служебные слова (и, в, на,
// с, к, по, за, у …) отсекаются в основном длиной; здесь добиваем 3+-символьные шумовые.
const STOP_WORDS = new Set([
  // RU
  'и', 'в', 'во', 'на', 'с', 'со', 'к', 'ко', 'по', 'за', 'из', 'от', 'до', 'о', 'об',
  'обо', 'для', 'что', 'как', 'не', 'ни', 'но', 'а', 'же', 'бы', 'ли', 'или', 'то',
  'это', 'эта', 'этот', 'эти', 'при', 'над', 'под', 'без', 'про', 'у', 'его', 'её', 'ее',
  'их', 'так', 'уже', 'все', 'всё', 'был', 'быть', 'есть', 'чтобы', 'между', 'через',
  // EN
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'was',
  'be', 'by', 'with', 'as', 'at', 'from', 'that', 'this', 'it', 'its', 'into', 'than',
  'then', 'not', 'no', 'via', 'per',
]);

// Разбить текст на нижне-регистровые токены (буквы/цифры Unicode: латиница + кириллица).
function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Значимые токены: длина >= 3 и не стоп-слово (порядок исходный, без сортировки).
function significantTokens(text) {
  return tokenize(text).filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

// Детерминированная сигнатура проблемы: нижний регистр, без пунктуации, без коротких/
// стоп-слов, отсортированные уникальные значимые токены через пробел. Одинаковый вход →
// одинаковый выход и стабильный порядок (годится как ключ похожести проблем).
export function normalizeSignature(text) {
  const uniq = [...new Set(significantTokens(text))];
  uniq.sort();
  return uniq.join(' ');
}

// Первый значимый токен (в исходном порядке) — грубая «область» решения; иначе 'general'.
function firstSignificantToken(text) {
  const tokens = significantTokens(text);
  return tokens[0] || 'general';
}

// ── Разбор DECISIONS.md (ADR) ───────────────────────────────────────────────────

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Схлопнуть переносы/повторные пробелы в один пробел, обрезать края.
function cleanText(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

// Убрать inline-разметку (backtick/звёздочки) из заголовка.
function stripInlineMarkup(s) {
  return String(s ?? '').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
}

// Достать значение буллета `- **Label:**` из тела секции. Значение тянется до следующего
// буллета (любого уровня), следующего заголовка `##` или конца тела — с учётом
// continuation-строк (перенесённый текст с отступом, без дефиса).
function extractBulletField(body, label) {
  const re = new RegExp(
    `(?:^|\\n)[ \\t]*-\\s+\\*\\*${escapeRe(label)}:\\*\\*\\s*([\\s\\S]*?)(?=\\n[ \\t]*-\\s|\\n##\\s|$)`,
    'i',
  );
  const m = String(body).match(re);
  return m ? cleanText(m[1]) : '';
}

// Достать список связанной памяти из `- Связано с памятью:`. Ключи памяти обычно
// backtick-квотированы (`smeta-iam-auth-migration`) — берём содержимое кавычек; если
// кавычек нет, режем по запятым и чистим краевую пунктуацию.
function extractMemoryField(body) {
  const re = /(?:^|\n)[ \t]*-\s+Связано с памятью:\s*([\s\S]*?)(?=\n[ \t]*-\s|\n##\s|$)/i;
  const m = String(body).match(re);
  if (!m) return [];
  const value = m[1];
  const quoted = [...value.matchAll(/`([^`]+)`/g)].map((q) => q[1].trim()).filter(Boolean);
  if (quoted.length) return quoted;
  return value
    .split(/[,\n]+/)
    .map((s) => s.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
}

// Разобрать ADR-журнал (`## ADR-NN. Title` + буллеты). На каждый ADR — строка 'adopted';
// при наличии «Альтернативы» дополнительно companion-строка 'rejected' (adr-NN-alt).
// Устойчиво к отсутствующим полям (пустые строки '', пустые массивы []).
export function parseDecisionsMarkdown(md, opts = {}) {
  const text = String(md ?? '');
  const sourceRef = opts?.sourceRef || 'DECISIONS.md';
  const rows = [];

  // Собираем позиции заголовков, затем нарезаем тела секций.
  const headerRe = /^##\s+ADR-(\d+)\.?\s*(.*)$/gim;
  const heads = [];
  let m;
  while ((m = headerRe.exec(text)) !== null) {
    heads.push({ nn: m[1], title: (m[2] || '').trim(), start: m.index, bodyStart: headerRe.lastIndex });
  }

  for (let i = 0; i < heads.length; i += 1) {
    const cur = heads[i];
    const bodyEnd = i + 1 < heads.length ? heads[i + 1].start : text.length;
    const body = text.slice(cur.bodyStart, bodyEnd);

    const nn = cur.nn;
    const id = `adr-${nn.toLowerCase()}`;
    const title = stripInlineMarkup(cur.title);
    const approach = extractBulletField(body, 'Решение');
    const reason = extractBulletField(body, 'Почему');
    const alternatives = extractBulletField(body, 'Альтернативы');
    const forbidden = extractBulletField(body, 'Нельзя менять');
    const related = extractMemoryField(body);
    const area = firstSignificantToken(title);

    rows.push({
      decision_id: id,
      source: 'decisions_md',
      status: 'adopted',
      title,
      approach,
      reason,
      forbidden,
      alternatives,
      area,
      problem_signature: normalizeSignature(`${title} ${approach}`),
      source_ref: sourceRef,
      related_memory: related,
    });

    // Отвергнутая альтернатива → отдельная строка со статусом 'rejected'.
    if (alternatives) {
      rows.push({
        decision_id: `${id}-alt`,
        source: 'decisions_md',
        status: 'rejected',
        title,
        approach: alternatives,
        reason: `отвергнутая альтернатива (ADR-${nn})`,
        forbidden: '',
        alternatives: '',
        area,
        superseded_by: id,
        problem_signature: normalizeSignature(alternatives),
        source_ref: sourceRef,
        related_memory: [],
      });
    }
  }

  return rows;
}

// ── Разбор git log --oneline ────────────────────────────────────────────────────

// Область из conventional-commit заголовка: `type(scope): ...` → scope; `type: ...` → type;
// иначе 'general'.
function conventionalScope(subject) {
  const m = String(subject).match(/^(\w[\w-]*)(?:\(([^)]+)\))?!?:\s/);
  if (!m) return 'general';
  const scope = (m[2] || m[1] || 'general').trim().toLowerCase();
  return scope || 'general';
}

// Разобрать вывод `git log --oneline` (строки `<sha> <subject>`) в строки-решения 'adopted'.
// Пустые строки и строки без sha/темы игнорируются.
export function parseGitLogDecisions(text, opts = {}) {
  const repo = opts?.repo || '';
  const rows = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([0-9a-f]{4,40})\s+(.*)$/i);
    if (!m) continue;
    const sha = m[1];
    const subject = m[2].trim();
    if (!subject) continue;
    rows.push({
      decision_id: `git:${sha}`,
      source: 'git',
      status: 'adopted',
      title: subject,
      approach: subject,
      area: conventionalScope(subject),
      git_commits: [sha],
      problem_signature: normalizeSignature(subject),
      reason: '',
      forbidden: '',
      alternatives: '',
      source_ref: repo,
      related_memory: [],
    });
  }
  return rows;
}

// ── Нормализация строки для вставки ──────────────────────────────────────────────

// Текущее время в формате ClickHouse DateTime64(3) 'YYYY-MM-DD HH:MM:SS.mmm' (UTC).
function chNow() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function toStr(v) {
  return v == null ? '' : String(v);
}

function toStrArray(v) {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

// Полная строка со ВСЕМИ колонками таблицы. Строки по умолчанию '', массивы [],
// updated_at — текущее время. `version` НЕ задаём — в CH это DEFAULT из updated_at.
export function decisionRow(partial = {}) {
  const p = partial || {};
  return {
    decision_id: toStr(p.decision_id),
    source: toStr(p.source),
    area: toStr(p.area) || 'general',
    title: toStr(p.title),
    problem_signature: toStr(p.problem_signature),
    approach: toStr(p.approach),
    status: toStr(p.status) || 'adopted',
    reason: toStr(p.reason),
    forbidden: toStr(p.forbidden),
    alternatives: toStr(p.alternatives),
    superseded_by: toStr(p.superseded_by),
    git_commits: toStrArray(p.git_commits),
    related_memory: toStrArray(p.related_memory),
    source_ref: toStr(p.source_ref),
    updated_at: p.updated_at ? toStr(p.updated_at) : chNow(),
  };
}

// ── Схема ClickHouse (best-effort, идемпотентная) ────────────────────────────────

function decisionsDb() {
  return process.env.CLICKHOUSE_DATABASE || 'orchestrator';
}

export function decisionsTable() {
  return process.env.CLICKHOUSE_DECISIONS_TABLE || 'decisions';
}

// Полностью квалифицированное имя таблицы `<db>.<table>`.
function fullTableName() {
  return `${decisionsDb()}.${decisionsTable()}`;
}

// Идемпотентный DDL: БД, таблица (ReplacingMergeTree по version), view отвергнутых решений.
// Таблица маленькая — PARTITION BY опускаем (tuple()); ORDER BY определяет ключ дедупликации.
export function decisionSchemaStatements() {
  const db = decisionsDb();
  const table = fullTableName();
  return [
    `CREATE DATABASE IF NOT EXISTS ${db}`,
    `CREATE TABLE IF NOT EXISTS ${table}
(
    decision_id String,
    source LowCardinality(String),
    area LowCardinality(String),
    title String,
    problem_signature String,
    approach String,
    status LowCardinality(String) DEFAULT 'adopted',
    reason String,
    forbidden String,
    alternatives String,
    superseded_by String,
    git_commits Array(String),
    related_memory Array(String),
    source_ref String,
    updated_at DateTime64(3, 'UTC') DEFAULT now64(3),
    version UInt64 DEFAULT toUnixTimestamp64Milli(updated_at)
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (status, area, decision_id)
SETTINGS index_granularity = 8192`,
    `CREATE OR REPLACE VIEW ${db}.decisions_rejected AS SELECT * FROM ${table} FINAL WHERE status IN ('rejected', 'superseded')`,
  ];
}

let ensuringDecisions = null;

// Накатить схему реестра решений (best-effort). Возвращает {ok} / {ok:false,error} /
// {skipped}. Никогда не бросает. Дедуплицируется модульным промисом (по образцу
// ensureClickhouseSchema): параллельные вызовы ждут один и тот же прогон.
export async function ensureDecisionSchema(opts = {}) {
  if (!clickhouseEnabled()) return { skipped: true, reason: 'disabled' };
  if (ensuringDecisions) return ensuringDecisions;
  ensuringDecisions = (async () => {
    const attempts = Number.isInteger(opts.attempts) ? opts.attempts : 3;
    const retryDelayMs = opts.retryDelayMs ?? 1500;
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        for (const sql of decisionSchemaStatements()) {
          await clickhouseCommand(sql, { timeoutMs: opts.timeoutMs });
        }
        return { ok: true, attempt };
      } catch (error) {
        lastErr = error;
        if (attempt < attempts) await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
    return { ok: false, error: lastErr?.message };
  })();
  try {
    return await ensuringDecisions;
  } finally {
    ensuringDecisions = null;
  }
}

// Upsert строк-решений (best-effort). Гейт clickhouseEnabled(); пусто → {skipped}.
// При «нет таблицы/БД» — накатить схему и повторить один раз. Никогда не бросает.
export async function upsertDecisions(rows) {
  if (!clickhouseEnabled()) return { skipped: true, reason: 'disabled' };
  if (!Array.isArray(rows) || rows.length === 0) return { skipped: true, reason: 'empty' };
  const table = fullTableName();
  const payload = rows.map(decisionRow);
  try {
    await clickhouseInsertJSONEachRow(table, payload);
    return { ok: true, rows: payload.length };
  } catch (error) {
    // Ленивый self-heal: таблицы/БД нет → накатить схему и повторить ровно один раз.
    if (isMissingSchemaError(error)) {
      await ensureDecisionSchema();
      try {
        await clickhouseInsertJSONEachRow(table, payload);
        return { ok: true, rows: payload.length };
      } catch (retryError) {
        log.warn('ClickHouse upsert решений не удался после накатки схемы', {
          event_code: 'OBSERVABILITY_EXPORT_SKIPPED',
          operation: 'clickhouse.decisions.upsert',
          err: retryError,
        });
        return { skipped: true, error: retryError.message };
      }
    }
    log.warn('ClickHouse upsert решений пропущен', {
      event_code: 'OBSERVABILITY_EXPORT_SKIPPED',
      operation: 'clickhouse.decisions.upsert',
      err: error,
    });
    return { skipped: true, error: error.message };
  }
}

// Экспортируется для юнит-тестов чистых функций разбора/нормализации.
export const __test__ = {
  normalizeSignature,
  parseDecisionsMarkdown,
  parseGitLogDecisions,
  decisionRow,
  conventionalScope,
  firstSignificantToken,
};

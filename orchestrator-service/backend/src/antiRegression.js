// Анти-регрессия решений (ADVISORY / observe-only).
//
// Назначение: перед тем как в оркестраторе будет принят какой-то подход, сверить
// его формулировку с реестром РАНЕЕ ОТВЕРГНУТЫХ (status IN ('rejected','superseded'))
// решений, чтобы не ходить по кругу и не переизобретать то, что уже пробовали и
// сознательно отклонили. Этот слой НИЧЕГО не блокирует — он только СООБЩАЕТ о
// похожих отвергнутых решениях (flagged), окончательное решение за человеком/ролью.
//
// Источник данных — таблица `<db>.decisions` в ClickHouse (её ведёт отдельный
// модуль decisionLedger.js; мы на него НЕ импортируемся, только читаем тот же CH
// по SQL). Best-effort: недоступность/выключенность ClickHouse НЕ ломает работу —
// гейт clickhouseEnabled() + try/catch на внешнем вызове → пустой результат.
//
// Чистые функции (tokenize/signatureTokens/scoreMatch/matchRejected) детерминированы
// и покрыты юнит-тестами без обращения к ClickHouse.

import {
  clickhouseEnabled,
  clickhouseCommand,
  isMissingSchemaError,
} from './clickhouseClient.js';
import { createLogger } from '../../../shared/logging/index.js';

const log = createLogger({ service: 'orchestrator-service' });

// Стоп-слова (RU+EN): служебные, не несущие смысла для сравнения подходов.
const STOP_WORDS = new Set([
  // RU
  'и', 'в', 'на', 'для', 'по', 'что', 'как', 'не', 'же', 'бы', 'ли', 'то',
  'из', 'от', 'до', 'за', 'со', 'об', 'при', 'над', 'под', 'без', 'про',
  'это', 'этот', 'эта', 'эти', 'тот', 'там', 'тут', 'вот', 'уже', 'ещё', 'еще',
  'или', 'но', 'да', 'нет', 'был', 'была', 'было', 'быть', 'есть', 'мы', 'вы',
  'он', 'она', 'они', 'его', 'её', 'ее', 'их', 'наш', 'ваш', 'все', 'всё',
  'так', 'нам', 'вам', 'нас', 'вас', 'кто', 'где', 'чем', 'чём', 'который',
  'давай', 'сделаем', 'сделать', 'через',
  // EN
  'the', 'a', 'an', 'of', 'to', 'for', 'with', 'and', 'or', 'not', 'in', 'on',
  'at', 'by', 'as', 'is', 'are', 'be', 'was', 'were', 'this', 'that', 'these',
  'those', 'it', 'its', 'we', 'you', 'they', 'from', 'into', 'via', 'let',
]);

const MIN_TOKEN_LENGTH = 3;

// Разбить текст на значимые токены: нижний регистр, без пунктуации, по пробелам,
// отсеять короткие (<3) и стоп-слова. Возвращает массив (с возможными повторами).
export function tokenize(text) {
  if (text == null) return [];
  const s = String(text).toLowerCase();
  // Всё, что не буква/цифра (латиница/кириллица), считаем разделителем.
  const parts = s.split(/[^0-9a-zа-яё]+/i);
  const out = [];
  for (const raw of parts) {
    const t = raw.trim();
    if (!t) continue;
    if (t.length < MIN_TOKEN_LENGTH) continue;
    if (STOP_WORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

// Уникальные значимые токены текста в стабильном (отсортированном) порядке.
export function signatureTokens(text) {
  return [...new Set(tokenize(text))].sort();
}

// Мера пересечения множеств токенов (Jaccard: |A∩B| / |A∪B|), 0..1.
// Пустые множества → 0 (не с чем сравнивать).
export function scoreMatch(aTokens, bTokens) {
  const a = aTokens instanceof Set ? aTokens : new Set(aTokens || []);
  const b = bTokens instanceof Set ? bTokens : new Set(bTokens || []);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

// Поля решения, по которым имеет смысл сверять формулировку подхода.
const MATCH_FIELDS = ['problem_signature', 'approach', 'title', 'alternatives', 'forbidden'];

// Сопоставить кандидата с реестром отвергнутых решений. Чистая функция.
//   candidate = { text, area? }
//   rejectedDecisions = массив строк решений (как в CH-таблице)
//   opts = { threshold=0.45, limit=5, area? }
// Для каждого решения score = max(scoreMatch кандидата против его полей). Если
// область совпадает (opts.area || candidate.area === decision.area) — небольшой
// бонус (+0.1, потолок 1), т.к. в той же области повтор особенно подозрителен.
// Возвращает отсортированный по score desc массив [{decision, score}] со score>=threshold,
// не длиннее limit.
export function matchRejected(candidate, rejectedDecisions, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : 0.45;
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 5;
  const area = opts.area ?? candidate?.area ?? null;

  const candTokens = new Set(tokenize(candidate?.text));
  if (candTokens.size === 0) return [];
  if (!Array.isArray(rejectedDecisions) || rejectedDecisions.length === 0) return [];

  const scored = [];
  for (const decision of rejectedDecisions) {
    if (!decision || typeof decision !== 'object') continue;
    let best = 0;
    for (const field of MATCH_FIELDS) {
      const value = decision[field];
      if (!value) continue;
      const s = scoreMatch(candTokens, new Set(tokenize(value)));
      if (s > best) best = s;
    }
    // Бонус за совпадение области — только когда есть базовое пересечение.
    if (best > 0 && area && decision.area && String(decision.area) === String(area)) {
      best = Math.min(1, best + 0.1);
    }
    if (best >= threshold) scored.push({ decision, score: best });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ── Best-effort доступ к ClickHouse ─────────────────────────────────────────────

function decisionsDatabase() {
  return process.env.CLICKHOUSE_DATABASE || 'orchestrator';
}

// Прочитать реестр отвергнутых/вытесненных решений из ClickHouse. Best-effort:
// если CH выключен, таблицы ещё нет или запрос упал — вернуть [] (никогда не бросать).
export async function fetchRejectedDecisions(opts = {}) {
  if (!clickhouseEnabled()) return [];
  const db = decisionsDatabase();
  const sql =
    `SELECT decision_id, area, title, problem_signature, approach, status, reason, ` +
    `forbidden, alternatives, superseded_by ` +
    `FROM ${db}.decisions FINAL ` +
    `WHERE status IN ('rejected','superseded') ` +
    `FORMAT JSONEachRow`;
  try {
    const text = await clickhouseCommand(sql);
    const rows = [];
    for (const line of String(text).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        // Битую строку пропускаем — не роняем всю выборку.
      }
    }
    return rows;
  } catch (error) {
    // Нет таблицы/БД (реестр ещё не заведён) — это норма, тихий debug.
    if (isMissingSchemaError(error)) {
      log.debug('Реестр решений ещё не создан — анти-регрессия пропущена', {
        operation: 'antiRegression.fetch',
      });
    } else {
      log.warn('Чтение реестра отвергнутых решений пропущено (CH недоступен)', {
        operation: 'antiRegression.fetch',
        err: error,
      });
    }
    return [];
  }
}

// Проверить предлагаемый подход против реестра отвергнутых решений. Никогда не бросает.
//   candidate = { text, area? }
//   opts = { threshold?, limit?, area? }
// Возвращает { flagged, checked, matches:[{decision_id, status, score, area, reason, forbidden}] }.
//   checked=false — реестр недоступен (CH выключен/ошибка), проверку выполнить не удалось;
//   flagged=true  — найдено хотя бы одно похожее отвергнутое решение.
export async function checkApproach(candidate, opts = {}) {
  if (!clickhouseEnabled()) {
    return { flagged: false, checked: false, matches: [] };
  }
  try {
    const rejected = await fetchRejectedDecisions(opts);
    // Пустой реестр отличаем от «не проверяли»: CH включён — проверка состоялась.
    const found = matchRejected(candidate, rejected, opts);
    const matches = found.map(({ decision, score }) => ({
      decision_id: decision.decision_id ?? null,
      status: decision.status ?? null,
      score: Math.round(score * 1000) / 1000,
      area: decision.area ?? null,
      reason: decision.reason ?? null,
      forbidden: decision.forbidden ?? null,
    }));
    if (matches.length) {
      log.debug('Анти-регрессия: подход похож на ранее отвергнутые решения', {
        operation: 'antiRegression.check',
        attributes: { matches: matches.length, top: matches[0]?.decision_id },
      });
    }
    return { flagged: matches.length > 0, checked: true, matches };
  } catch (error) {
    // Защитный контур: checkApproach не должен бросать ни при каких условиях.
    log.warn('Анти-регрессия: проверка подхода пропущена', {
      operation: 'antiRegression.check',
      err: error,
    });
    return { flagged: false, checked: false, matches: [] };
  }
}

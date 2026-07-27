// PROVIDER-LIMIT-COOLDOWN-002 — распознавание «мягкого» отказа LLM-провайдера
// (превышение лимита подписки/квоты/троттлинг/перегрузка) и разбор времени сброса.
//
// «Мягкий» отказ держится долго — долбить провайдер бессмысленно. Раннеры отличают
// его от реальных сбоев (краш/таймаут/сеть, которые штатно переигрываются) и уходят
// в паузу до времени сброса.
//
// Единый источник для programmer-runner и codex-runner (@orchestrator/shared):
// раньше эта regex и парсер были продублированы в ProgrammerRunner и ReasoningRunner
// с пометкой «канон — синхронизируй в обоих».

// Разделитель между словами — пробел/подчёркивание/дефис: провайдеры пишут и
// «usage limit», и «rate_limit_error», и «too-many-requests». Плюс «hit your session
// limit»/403/429/529/«resets HH:MM»: claude_code при исчерпании подписки пишет
// «You've hit your session limit · resets 6:50am» — без этих паттернов пауза не
// срабатывала (churn 10.07).
export function isProviderLimit(reason) {
  return /hit your session limit|usage[\s_-]?limit|rate[\s_-]?limit|too[\s_-]?many[\s_-]?requests|\b403\b|\b429\b|\b529\b|quota|insufficient|overloaded|try again (at|later|in)|resets?\s+\d/i.test(
    String(reason || ''),
  );
}

// Разобрать явное время сброса лимита из текста ошибки («resets 6:50am», «try again
// at 14:00») в абсолютный ms. null — время в тексте не найдено (тогда вызывающий
// применяет фиксированный cooldown).
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

/** Форматирование дат для UI (локаль ru-RU). */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Простой генератор id без внешних зависимостей. */
export function makeId(prefix = 'id'): string {
  const rnd = Math.floor(Math.random() * 1e9).toString(36);
  return `${prefix}_${Date.now().toString(36)}${rnd}`;
}

/** Время ЧЧ:ММ:СС (локаль ru-RU) — для отметки последнего обновления. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Человекочитаемая длительность из миллисекунд. `null` → «Нет данных»
 * (а не 0). Показывает до двух старших значимых единиц (д/ч/мин/сек).
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return 'Нет данных';
  if (ms < 1000) return 'меньше секунды';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} д`);
  if (hours) parts.push(`${hours} ч`);
  if (mins) parts.push(`${mins} мин`);
  if (secs && parts.length < 2) parts.push(`${secs} сек`);
  return parts.slice(0, 2).join(' ') || `${secs} сек`;
}

/** Стоимость прогонов в долларах: `$79.99`, `$0.00` при отсутствии. */
export function formatCost(usd: number | null | undefined): string {
  const n = Number(usd);
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

/**
 * Компактное число токенов: `1.2M`, `543k`, `812`. Для tooltip с разбивкой
 * KPI, где полная разрядность мешает читать.
 */
export function formatCompact(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(v));
}

/** Русское склонение существительного по числу. */
export function plural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (d > 1 && d < 5) return forms[1];
  if (d === 1) return forms[0];
  return forms[2];
}

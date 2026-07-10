// CONFIG-AUDIT-001 — единый разбор числовых env с единицами измерения, проверкой
// диапазона и атрибуцией источника (env | default).
//
// Зачем: по проекту значения вида timeout/interval/concurrency читались паттерном
//   Number(process.env.X || 600000)
// у которого две беды:
//   1) при мусоре (X="abc") получаем Number("abc") = NaN → setTimeout(fn, NaN)
//      срабатывает НЕМЕДЛЕННО (как 0) → задача рубится сразу. Опасный фолбэк.
//   2) из лога не видно, ОТКУДА пришло значение (env или дефолт).
//
// Копия programmer-runner/src/envConfig.js (codex-runner — отдельный npm-пакет,
// как и дублированный ReasoningRunner.js). Любую правку синхронизируй в обоих.

const DURATION_UNITS = { ms: 1, s: 1000, sec: 1000, m: 60_000, min: 60_000, h: 3_600_000 };

/**
 * Разобрать длительность в миллисекунды. Принимает голое число (ms) или с
 * суффиксом единицы: "540000", "540s", "9m", "9min", "1h".
 * @returns {number|null|NaN} ms; null — не задано (пусто); NaN — мусор.
 */
export function parseDurationMs(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === '') return null;
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|sec|s|min|m|h)?$/);
  if (!m) return NaN;
  return Math.round(Number(m[1]) * DURATION_UNITS[m[2] || 'ms']);
}

function parseIntStrict(raw) {
  const s = String(raw).trim();
  if (s === '') return null;
  if (!/^-?\d+$/.test(s)) return NaN;
  return Number(s);
}

function resolve(name, dflt, parse, { env, min, max, unit }) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') {
    return { name, value: dflt, source: 'default', default: dflt, raw: null, warning: null };
  }
  const parsed = parse(raw);
  if (parsed == null || Number.isNaN(parsed)) {
    return {
      name, value: dflt, source: 'default', default: dflt, raw: String(raw),
      warning: `некорректное значение ${name}="${raw}" — применён дефолт ${dflt}${unit}`,
    };
  }
  if (parsed < min || parsed > max) {
    return {
      name, value: dflt, source: 'default', default: dflt, raw: String(raw),
      warning: `${name}=${parsed}${unit} вне диапазона [${min}..${max}] — применён дефолт ${dflt}${unit}`,
    };
  }
  return { name, value: parsed, source: 'env', default: dflt, raw: String(raw), warning: null };
}

export function resolveDuration(name, defaultMs, opts = {}) {
  const { env = process.env, min = 0, max = Number.POSITIVE_INFINITY } = opts;
  return resolve(name, defaultMs, parseDurationMs, { env, min, max, unit: 'ms' });
}

export function resolveInt(name, defaultVal, opts = {}) {
  const { env = process.env, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = opts;
  return resolve(name, defaultVal, parseIntStrict, { env, min, max, unit: '' });
}

export function logEffectiveConfig(label, entries, log = console) {
  const eff = {};
  for (const e of entries) {
    eff[e.name] = { value: e.value, source: e.source, envName: e.name, defaultValue: e.default };
    if (e.warning) (log.warn || log.error || log.log)?.call(log, `${label}: ${e.warning}`);
  }
  (log.log || log.info)?.call(log, `${label} effectiveConfig=${JSON.stringify(eff)}`);
  return eff;
}

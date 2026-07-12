// MCP-SERVICE-001 — конфигурация сервиса из переменных окружения.
//
// Тонкий адаптер не хранит секретов и не дублирует бизнес-логику: только адреса
// нижележащих сервисов, токен и feature-флаги доступа к мутациям.
//
// MCP-TOKEN-SYNC-001 — единый источник токена для всех способов запуска.
// Проблема: stdio-процесс (Codex/VS Code) стартует из окружения, где env-блок
// клиента (~/.codex/config.toml) НЕ поддерживает подстановку ${VAR}, поэтому
// ORCHESTRATOR_API_TOKEN туда не попадает → запросы к /api/* уходят без Bearer и
// возвращают 401. Docker/HTTP-запуск при этом получает токен через окружение
// контейнера. Чтобы не копировать секрет в несколько конфигов, недостающие
// переменные (в т.ч. токен) добираются из репозиторного .env — единого источника.
// Приоритет у process.env: явно заданное окружение (Docker/оболочка/config.toml)
// НЕ перетирается файлом .env, а stdio без переменной добирает секрет из .env.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** Привести значение env к boolean: 1/true/yes/on (без учёта регистра) → true. */
export function truthy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Путь к репозиторному .env по умолчанию — на два уровня выше этого модуля
 * (`<repo>/mcp-service/src/config.js` → `<repo>/.env`). Резолвится ОТ файла
 * модуля, а не от cwd: stdio-клиент (Codex) запускает процесс с произвольным cwd.
 */
export function defaultEnvFilePath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
}

/**
 * Разобрать содержимое .env (минимальный парсер, без зависимости dotenv):
 * строки `KEY=VALUE`, пустые строки и `# комментарии` пропускаются, поддержан
 * префикс `export `, снимаются окружающие кавычки. Значения НЕ логируются.
 */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = body.slice(eq + 1).trim();
    if (
      val.length >= 2 &&
      ((val[0] === '"' && val.at(-1) === '"') || (val[0] === "'" && val.at(-1) === "'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Прочитать и разобрать .env; отсутствие/недоступность файла — не ошибка ({}). */
export function loadEnvFile(filePath, readFile = (p) => readFileSync(p, 'utf8')) {
  let text;
  try {
    text = readFile(filePath);
  } catch {
    return {};
  }
  return parseEnv(text);
}

/**
 * Собрать эффективное окружение: значения из .env-файла заполняют ТОЛЬКО то, что
 * не задано в baseEnv (process.env). Путь файла — из baseEnv.MCP_ENV_FILE, иначе
 * defaultEnvFilePath(). Приоритет baseEnv гарантирует, что явный Docker/CLI-env
 * не перетирается репозиторным .env.
 */
export function resolveEnv(baseEnv = process.env, { readFile } = {}) {
  const filePath = String(baseEnv.MCP_ENV_FILE || '').trim() || defaultEnvFilePath();
  const fileVals = loadEnvFile(filePath, readFile);
  return { ...fileVals, ...baseEnv };
}

/** Снять хвостовые '/' у базового URL, чтобы пути склеивались без двойных слэшей. */
function trimUrl(v, fallback) {
  const s = String(v ?? '').trim();
  return (s || fallback).replace(/\/+$/, '');
}

/**
 * Собрать конфиг из env. Значения по умолчанию рассчитаны на локальный запуск из
 * Claude Code / Codex / VS Code (orchestrator на :4186, tools-service на :4188).
 * По умолчанию env = resolveEnv(): process.env + добор недостающего из репо .env
 * (единый источник токена). Явно переданный env НЕ дополняется из файла —
 * поведение остаётся чистым и детерминированным для юнит-тестов.
 */
export function loadConfig(env = resolveEnv()) {
  return {
    projectRoot: String(env.PROJECT_ROOT || process.cwd()),
    orchestratorUrl: trimUrl(env.ORCHESTRATOR_URL, 'http://localhost:4186'),
    toolsServiceUrl: trimUrl(env.TOOLS_SERVICE_URL, 'http://localhost:4188'),
    orchestratorToken: String(env.ORCHESTRATOR_API_TOKEN || '').trim(),
    allowInsecureLocal: truthy(env.ALLOW_INSECURE_LOCAL),
    port: Number(env.MCP_SERVICE_PORT || 4190),
    requestTimeoutMs: Math.max(1000, Number(env.MCP_REQUEST_TIMEOUT_MS || 30000)),
    // Лимит тела входящего POST /mcp (защита от DoS большим запросом). 1 МБ.
    bodyLimitBytes: Math.max(1024, Number(env.MCP_BODY_LIMIT_BYTES || 1048576)),
    // Доступ к записи/удалению/мутациям оркестратора — только по явному флагу.
    enableWrite: truthy(env.MCP_ENABLE_WRITE),
    enableDelete: truthy(env.MCP_ENABLE_DELETE),
    enableOrchestratorMutations: truthy(env.MCP_ENABLE_ORCHESTRATOR_MUTATIONS),
  };
}

/**
 * MCP-TOKEN-SYNC-001 — проверка согласованности ORCHESTRATOR_URL,
 * ORCHESTRATOR_API_TOKEN и mutation-флага. Даёт понятную диагностику ДО первого
 * вызова инструмента (на старте stdio и в /health), чтобы отсутствие токена не
 * всплывало как внезапный 401. НИКОГДА не возвращает значение токена — только
 * булев `tokenConfigured`.
 */
export function checkConfig(config = loadConfig()) {
  const tokenConfigured = Boolean(config.orchestratorToken);
  const problems = [];

  if (!config.orchestratorUrl) {
    problems.push({
      level: 'error',
      code: 'orchestrator_url_missing',
      message: 'ORCHESTRATOR_URL пуст — запросы оркестратора отправлять некуда.',
    });
  }

  if (config.enableOrchestratorMutations && !tokenConfigured && !config.allowInsecureLocal) {
    problems.push({
      level: 'error',
      code: 'mutations_without_token',
      message:
        'MCP_ENABLE_ORCHESTRATOR_MUTATIONS=1, но ORCHESTRATOR_API_TOKEN пуст: мутации ' +
        '(orchestrator_create_task и др.) получат 401. Задайте токен в едином источнике — ' +
        'репозиторном .env (ключ ORCHESTRATOR_API_TOKEN) — либо снимите mutation-флаг, либо ' +
        'разрешите локальную работу без токена (ALLOW_INSECURE_LOCAL=1).',
    });
  }

  const ok = !problems.some((p) => p.level === 'error');
  return {
    ok,
    orchestratorUrl: config.orchestratorUrl,
    tokenConfigured,
    mutationsEnabled: config.enableOrchestratorMutations,
    allowInsecureLocal: config.allowInsecureLocal,
    problems,
  };
}

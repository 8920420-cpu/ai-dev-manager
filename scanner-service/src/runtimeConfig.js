// Резолв режима работы Scanner из переменных окружения. Чистая функция —
// тестируется без ФС/сети.
//
// Поддерживаются ДВА режима multi-watcher:
//   api      — папки наблюдения берутся из этапов проектов оркестратора
//              (SCANNER_API_BASE);
//   snapshot — папки наблюдения берутся из локального файла-снимка
//              (SCANNER_SNAPSHOT) + URL оркестратора из ORCHESTRATOR_API_BASE.
//
// Legacy single-watcher/feeder (SCANNER_DOCUMENT + TaskFeeder + FEEDER_*) удалён.
// Его переменные окружения больше НЕ определяют режим: при их наличии выдаётся
// диагностическое предупреждение, а сами они игнорируются.

// Переменные снятого legacy single-watcher/feeder режима. Их наличие — признак
// устаревшей конфигурации; режим из них не выводится.
export const LEGACY_SCANNER_ENV = [
  'SCANNER_DOCUMENT',
  'SCANNER_STATE',
  'SCANNER_ENDPOINT',
  'FEEDER_ENABLED',
  'FEEDER_INTERVAL_MS',
  'FEEDER_NEXT_ENDPOINT',
  'FEEDER_RELEASE_ENDPOINT',
];

// Ошибка неподдерживаемой конфигурации режима со стабильным машинным кодом.
export class ScannerModeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScannerModeError';
    this.code = 'scanner_mode_unsupported';
  }
}

function stripTrailingSlash(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

/**
 * Определить режим и базовые параметры запуска Scanner.
 * @param {Record<string,string|undefined>} env — окружение (process.env или объект в тесте).
 * @returns {{ mode:'api'|'snapshot', apiBase:string, orchestratorBase:string,
 *            snapshot:string, legacyEnvIgnored:string[] }}
 * @throws {ScannerModeError} если режим не задан явно или snapshot без URL оркестратора.
 */
export function resolveScannerRuntime(env = {}) {
  const apiBase = stripTrailingSlash(env.SCANNER_API_BASE);
  const orchestratorFallback = stripTrailingSlash(env.ORCHESTRATOR_API_BASE);
  const snapshot = String(env.SCANNER_SNAPSHOT ?? '').trim();
  const legacyEnvIgnored = LEGACY_SCANNER_ENV.filter(
    (k) => env[k] !== undefined && String(env[k]).length > 0,
  );

  // Режим определяется ТОЛЬКО явными переменными нового контракта.
  const mode = apiBase ? 'api' : snapshot ? 'snapshot' : null;
  if (!mode) {
    throw new ScannerModeError(
      'Scanner requires SCANNER_API_BASE (api mode) or SCANNER_SNAPSHOT (snapshot mode); ' +
        'legacy single-watcher mode was removed' +
        (legacyEnvIgnored.length ? ` (ignored legacy env: ${legacyEnvIgnored.join(', ')})` : ''),
    );
  }

  // URL оркестратора для отправки task-completed/task-intake. В api-режиме это
  // сам SCANNER_API_BASE; в snapshot-режиме обязателен ORCHESTRATOR_API_BASE.
  const orchestratorBase = apiBase || orchestratorFallback;
  if (mode === 'snapshot' && !orchestratorBase) {
    throw new ScannerModeError(
      'snapshot mode requires ORCHESTRATOR_API_BASE to post task results',
    );
  }

  return { mode, apiBase, orchestratorBase, snapshot, legacyEnvIgnored };
}

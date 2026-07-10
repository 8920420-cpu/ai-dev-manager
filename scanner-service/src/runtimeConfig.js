// Резолв режима работы Scanner из переменных окружения. Чистая функция —
// тестируется без ФС/сети.
//
// Поддерживаются ДВА режима multi-watcher:
//   api      — папки наблюдения берутся из этапов проектов оркестратора
//              (SCANNER_API_BASE);
//   snapshot — папки наблюдения берутся из локального файла-снимка
//              (SCANNER_SNAPSHOT) + URL оркестратора из ORCHESTRATOR_API_BASE.
//
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
 * @returns {{ mode:'api'|'snapshot', apiBase:string, orchestratorBase:string, snapshot:string }}
 * @throws {ScannerModeError} если режим не задан явно или snapshot без URL оркестратора.
 */
export function resolveScannerRuntime(env = {}) {
  const apiBase = stripTrailingSlash(env.SCANNER_API_BASE);
  const orchestratorFallback = stripTrailingSlash(env.ORCHESTRATOR_API_BASE);
  const snapshot = String(env.SCANNER_SNAPSHOT ?? '').trim();

  // Режим определяется ТОЛЬКО явными переменными нового контракта.
  const mode = apiBase ? 'api' : snapshot ? 'snapshot' : null;
  if (!mode) {
    throw new ScannerModeError(
      'Scanner requires SCANNER_API_BASE (api mode) or SCANNER_SNAPSHOT (snapshot mode)',
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

  return { mode, apiBase, orchestratorBase, snapshot };
}

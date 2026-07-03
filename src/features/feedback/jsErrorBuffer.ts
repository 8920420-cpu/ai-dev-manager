/**
 * Глобальный буфер последних JS-ошибок для автоконтекста виджета «Обратная связь»
 * (повторяет поведение ПС-виджета). Перехватывает `window.onerror` (событие 'error')
 * и `unhandledrejection` в кольцевой буфер ограниченного размера. Устанавливается
 * один раз (идемпотентно) при монтировании виджета.
 */

/** Сколько последних ошибок держим (кольцевой буфер). */
const MAX_ERRORS = 20;

const buffer: string[] = [];
let installed = false;

function timeLabel(): string {
  try {
    return `${new Date().toISOString()} `;
  } catch {
    return '';
  }
}

function push(entry: string): void {
  const text = String(entry ?? '').trim();
  if (!text) return;
  buffer.push(`${timeLabel()}${text}`);
  while (buffer.length > MAX_ERRORS) buffer.shift();
}

/** Ручная запись ошибки в буфер (например, из перехватчиков API). */
export function recordJsError(entry: string): void {
  push(entry);
}

/** Снимок буфера (копия) — кладётся в autocontext.jsErrors. */
export function getRecentJsErrors(): string[] {
  return buffer.slice();
}

/** Очистить буфер (используется в тестах). */
export function clearJsErrors(): void {
  buffer.length = 0;
}

/**
 * Установить глобальные перехватчики. Идемпотентно: повторный вызов ничего не делает.
 * Возвращает функцию снятия перехватчиков.
 */
export function installJsErrorCapture(): () => void {
  if (installed || typeof window === 'undefined') return () => {};
  installed = true;

  const onError = (event: ErrorEvent) => {
    const where = event.filename
      ? ` (${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0})`
      : '';
    push(`${event.message || 'Ошибка JavaScript'}${where}`);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const msg =
      reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    push(`Необработанное отклонение промиса: ${msg}`);
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    installed = false;
  };
}

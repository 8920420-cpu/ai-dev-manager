/** Общие типы домена. */

/** Статус живости/проверки соединения. */
export type ConnectionState = 'unknown' | 'checking' | 'success' | 'error';

/** Результат асинхронной проверки соединения. */
export interface CheckResult {
  state: ConnectionState;
  /** Человекочитаемое сообщение (для success/error). */
  message?: string;
  /** Метка времени последней проверки (ISO). */
  checkedAt?: string;
}

export const EMPTY_CHECK: CheckResult = { state: 'unknown' };

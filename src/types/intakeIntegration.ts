/**
 * INTAKE-INTEGRATIONS-001 — интеграция-источник обращений о проблемах (третий
 * канал приёма роли Task Intake Officer). Зарегистрированное внешнее приложение,
 * из которого пользователи сообщают о проблемах. Хранится на backend
 * (orchestrator-service, таблица intake_integrations). Токен доступа на клиент
 * НЕ приходит — есть только флаг hasToken; сам токен показывается один раз при
 * создании/перевыпуске.
 */
export interface IntakeIntegration {
  id: string;
  /** Название приложения-источника, напр. «ПС-чат». */
  name: string;
  /** Включена ли интеграция (выключенная не принимает обращения). */
  enabled: boolean;
  /** Анти-спам: лимит обращений в минуту по интеграции. */
  rateLimitPerMin: number;
  /** Анти-спам: лимит обращений в минуту по одному пользователю. */
  userRateLimitPerMin: number;
  /** Анти-спам: минимальная длина сообщения (короче — отклоняется). */
  minMessageLength: number;
  /** Выпущен ли токен доступа (сам токен клиенту не отдаётся). */
  hasToken: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Тело создания/обновления интеграции. Токен здесь не задаётся (генерируется). */
export interface IntakeIntegrationInput {
  name?: string;
  enabled?: boolean;
  rateLimitPerMin?: number;
  userRateLimitPerMin?: number;
  minMessageLength?: number;
}

/**
 * Ответ создания/перевыпуска: plaintext-токен приходит РОВНО ОДИН РАЗ (на сервере
 * хранится только его хэш). После закрытия окна токен не восстановить.
 */
export interface IntakeIntegrationWithToken extends IntakeIntegration {
  token: string;
}

/** Строка статистики принятых обращений по интеграции-источнику. */
export interface IntakeStatRow {
  id: string;
  name: string;
  enabled: boolean;
  /** Всего принято обращений. */
  total: number;
  /** Принято за последние 24 часа. */
  last24h: number;
  /** ISO-дата последнего обращения (или null). */
  lastReportAt: string | null;
}

export interface IntakeStats {
  integrations: IntakeStatRow[];
  totalReports: number;
}

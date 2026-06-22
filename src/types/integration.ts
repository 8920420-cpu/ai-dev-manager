import type { ConnectionState } from './common';

/**
 * Внешний коннектор (AI-провайдер), к которому подключается оркестратор.
 * Хранится на backend (orchestrator-service, таблица connectors). Секрет
 * (access token) на клиент не приходит — есть только флаг hasToken.
 */
export interface Integration {
  id: string;
  /** Название, напр. «DeepSeek». */
  name: string;
  /** Провайдер: deepseek | openai | ... (определяет дефолтную модель). */
  provider: string;
  /** Адрес endpoint коннектора (http/https URL). */
  endpoint: string;
  /** Модель (если пусто — берётся дефолт провайдера, напр. deepseek-chat). */
  model: string;
  /** Имя сервиса-потребителя (необязательно, для маршрутизации/журнала). */
  consumerService: string;
  /** Приоритет коннектора (меньше = выше). */
  priority: number;
  /** Включён ли коннектор. */
  isEnabled: boolean;
  /** Задан ли access token на сервере (сам токен клиенту не отдаётся). */
  hasToken: boolean;
  createdAt: string;
  updatedAt: string;
  /** Клиентское состояние последней проверки соединения (не персистится). */
  status?: ConnectionState;
  /** ISO-дата последней проверки (клиентская). */
  lastCheckedAt?: string;
}

/**
 * Тело создания/обновления коннектора. endpoint не передаётся — его определяет
 * провайдер на backend. token опционален (пустой при обновлении = не менять).
 */
export interface IntegrationInput {
  name: string;
  provider: string;
  model?: string;
  consumerService?: string;
  priority?: number;
  isEnabled?: boolean;
  /** Access token. Пустая строка/undefined при обновлении = «не менять». */
  accessToken?: string;
}

/** Статусы записи журнала обмена (как в backend/источнике). */
export type ExchangeStatus = 'Создан' | 'отправлен' | 'завершен' | 'ошибка';

/** Запись структурированного журнала обмена через коннектор. */
export interface PromptExchange {
  id: string;
  connectorId: string;
  consumerService: string;
  prompt: string | null;
  response: string | null;
  status: ExchangeStatus | string;
  isManual: boolean;
  error: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  createdAt: string;
}

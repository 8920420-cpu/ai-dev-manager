/**
 * Рантайм-настройки приложения (APP-SETTINGS-001). Backend:
 *   GET /api/app-settings  → текущие значения
 *   PUT /api/app-settings  → частичное обновление (валидация/клампинг на сервере)
 */
import { http } from './http';

/**
 * Движок исполнения рассуждающей роли (ROLE-ENGINE-ROUTING-001). Источник истины —
 * назначение коннектора роли (role_connectors); тип выводится из провайдера.
 */
export type RoleEngine = 'deepseek' | 'codex' | 'claude_code';

export interface AppSettings {
  /** Глобальный выключатель оркестратора: false запрещает выдачу и автоматическое продвижение задач. */
  orchestratorEnabled: boolean;
  /** Максимум параллельных обработок задач одной роли фоновым runner. */
  maxConcurrencyPerRole: number;
  /** Выделенных агентов PROGRAMMER (стадия CODING); зафиксировано на 1 (приоритетный слот). */
  programmerConcurrency: number;
  /**
   * TASK-AUTO-ACCEPT-001 — «не проверять выполненные задачи»: когда true (по
   * умолчанию), дошедшие до DONE задачи авто-принимаются (гейт «Проверка» отключён).
   */
  autoAcceptDone: boolean;
}

export const appSettingsApi = {
  async get(signal?: AbortSignal): Promise<AppSettings> {
    return http.get<AppSettings>('/api/app-settings', { signal });
  },

  async save(patch: Partial<AppSettings>): Promise<AppSettings> {
    return http.put<AppSettings>('/api/app-settings', patch);
  },
};

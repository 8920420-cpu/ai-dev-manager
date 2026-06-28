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
  /** Максимум параллельных обработок задач одной роли фоновым runner. */
  maxConcurrencyPerRole: number;
  /** Параллельных задач PROGRAMMER (стадия CODING); жёсткий потолок — 3. */
  programmerConcurrency: number;
}

export const appSettingsApi = {
  async get(signal?: AbortSignal): Promise<AppSettings> {
    return http.get<AppSettings>('/api/app-settings', { signal });
  },

  async save(patch: Partial<AppSettings>): Promise<AppSettings> {
    return http.put<AppSettings>('/api/app-settings', patch);
  },
};

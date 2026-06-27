/**
 * Рантайм-настройки приложения (APP-SETTINGS-001). Backend:
 *   GET /api/app-settings  → текущие значения
 *   PUT /api/app-settings  → частичное обновление (валидация/клампинг на сервере)
 */
import { http } from './http';

export interface AppSettings {
  /** Максимум параллельных обработок задач одной роли фоновым runner. */
  maxConcurrencyPerRole: number;
}

export const appSettingsApi = {
  async get(signal?: AbortSignal): Promise<AppSettings> {
    return http.get<AppSettings>('/api/app-settings', { signal });
  },

  async save(patch: Partial<AppSettings>): Promise<AppSettings> {
    return http.put<AppSettings>('/api/app-settings', patch);
  },
};

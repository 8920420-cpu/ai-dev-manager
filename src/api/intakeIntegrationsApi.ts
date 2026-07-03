/**
 * INTAKE-INTEGRATIONS-001 — реестр интеграций-источников обращений (третий канал
 * приёма роли Task Intake Officer) поверх backend оркестратора.
 * Endpoints (orchestrator-service/backend):
 *   GET    /api/intake-integrations                    → список (без токена)
 *   POST   /api/intake-integrations                    → создать (токен один раз)
 *   GET    /api/intake-integrations/stats              → статистика по источникам
 *   GET    /api/intake-integrations/:id                → одна интеграция
 *   PUT    /api/intake-integrations/:id                → обновить (вкл/выкл, лимиты)
 *   DELETE /api/intake-integrations/:id                → удалить
 *   POST   /api/intake-integrations/:id/rotate-token   → перевыпустить токен
 *
 * Приём самих обращений идёт в отдельный открытый endpoint POST /api/intake/report
 * (авторизация по токену интеграции), здесь не описан — это API приложения-источника.
 */
import { http } from './http';
import type {
  IntakeIntegration,
  IntakeIntegrationInput,
  IntakeIntegrationWithToken,
  IntakeStats,
} from '../types/intakeIntegration';

export const intakeIntegrationsApi = {
  async list(signal?: AbortSignal): Promise<IntakeIntegration[]> {
    const { integrations } = await http.get<{ integrations: IntakeIntegration[] }>(
      '/api/intake-integrations',
      { signal },
    );
    return integrations;
  },

  async create(input: IntakeIntegrationInput): Promise<IntakeIntegrationWithToken> {
    return http.post<IntakeIntegrationWithToken>('/api/intake-integrations', input);
  },

  async update(id: string, patch: IntakeIntegrationInput): Promise<IntakeIntegration> {
    return http.put<IntakeIntegration>(`/api/intake-integrations/${encodeURIComponent(id)}`, patch);
  },

  async rotateToken(id: string): Promise<IntakeIntegrationWithToken> {
    return http.post<IntakeIntegrationWithToken>(
      `/api/intake-integrations/${encodeURIComponent(id)}/rotate-token`,
    );
  },

  async remove(id: string): Promise<void> {
    await http.del(`/api/intake-integrations/${encodeURIComponent(id)}`);
  },

  async stats(signal?: AbortSignal): Promise<IntakeStats> {
    return http.get<IntakeStats>('/api/intake-integrations/stats', { signal });
  },
};

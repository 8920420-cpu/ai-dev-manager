/**
 * Репозиторий интеграций (коннекторов AI) поверх backend оркестратора.
 * Endpoints (orchestrator-service/backend):
 *   GET    /api/integrations              → список коннекторов (без токена)
 *   POST   /api/integrations              → создать
 *   GET    /api/integrations/:id          → один коннектор
 *   PUT    /api/integrations/:id          → обновить (пустой token = не менять)
 *   DELETE /api/integrations/:id          → удалить
 *   POST   /api/integrations/:id/invoke   → вызвать ИИ (записывает обмен)
 *   GET    /api/integrations/:id/exchanges → структурированный журнал обмена
 *
 * Безопасность: access token хранится только на сервере и НИКОГДА не приходит
 * клиенту (есть лишь флаг hasToken). Реальные вызовы DeepSeek идут с backend,
 * что обходит CORS и не светит секрет в браузере.
 */
import { http } from './http';
import type { Integration, IntegrationInput, PromptExchange } from '../types/integration';
import type { CheckResult } from '../types/common';

interface InvokeResult {
  ok: boolean;
  response: string;
  exchange: { id: string; status: string; httpStatus: number | null; durationMs: number | null };
}

export const integrationsApi = {
  async list(): Promise<Integration[]> {
    const { integrations } = await http.get<{ integrations: Integration[] }>('/api/integrations');
    return integrations.sort((a, b) => a.name.localeCompare(b.name));
  },

  async create(input: IntegrationInput): Promise<Integration> {
    return http.post<Integration>('/api/integrations', input);
  },

  async update(id: string, patch: Partial<IntegrationInput>): Promise<Integration> {
    return http.put<Integration>(`/api/integrations/${encodeURIComponent(id)}`, patch);
  },

  async remove(id: string): Promise<void> {
    await http.del(`/api/integrations/${encodeURIComponent(id)}`);
  },

  /** Структурированный журнал обмена через коннектор (последние сверху). */
  async exchanges(id: string): Promise<PromptExchange[]> {
    const { exchanges } = await http.get<{ exchanges: PromptExchange[] }>(
      `/api/integrations/${encodeURIComponent(id)}/exchanges`,
    );
    return exchanges;
  },

  /** Вызвать ИИ через коннектор (промт). Обмен записывается в журнал. */
  async invoke(id: string, prompt: string): Promise<InvokeResult> {
    return http.post<InvokeResult>(`/api/integrations/${encodeURIComponent(id)}/invoke`, {
      prompt,
    });
  },

  /**
   * Проверка соединения: отправляет короткий промт через backend и фиксирует
   * результат. Это реальная проверка endpoint + токена (в отличие от прежней
   * браузерной попытки, упиравшейся в CORS).
   */
  async checkConnection(id: string): Promise<CheckResult> {
    const checkedAt = new Date().toISOString();
    try {
      const r = await this.invoke(id, 'ping');
      return {
        state: 'success',
        message: r.exchange.durationMs
          ? `Коннектор ответил за ${r.exchange.durationMs} мс`
          : 'Коннектор ответил',
        checkedAt,
      };
    } catch (e) {
      return {
        state: 'error',
        message: e instanceof Error ? e.message : 'Коннектор недоступен',
        checkedAt,
      };
    }
  },
};

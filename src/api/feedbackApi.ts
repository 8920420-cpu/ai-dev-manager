/**
 * Клиент виджета «Обратная связь» оркестратора.
 *
 * Обращения уходят на same-origin endpoint'ы общего backend оркестратора
 * (ORCHESTRATOR-SERVICE):
 *   POST /api/feedback             — приём обращения; backend серверно подставляет
 *                                    токен интеграции «orchestrator-ui» и вызывает
 *                                    acceptIntakeReport (задача сразу в BACKLOG под
 *                                    Приёмщиком). Ответ — { reportNumber, ... }.
 *   POST /api/feedback/screenshot  — загрузка скриншота; хранение выбирает backend,
 *                                    в ответ приходит ссылка { url } (screenshotUrl).
 *
 * Секрет интеграции в бандл не зашивается — токен добавляет backend, браузер его не шлёт.
 */
import { http } from './http';
import type { FeedbackPayload, FeedbackResult, ScreenshotUploadResult } from '../types/feedback';

export const feedbackApi = {
  /** Загрузить скриншот (data URL) → получить ссылку для screenshotUrl обращения. */
  async uploadScreenshot(image: string, signal?: AbortSignal): Promise<ScreenshotUploadResult> {
    return http.post<ScreenshotUploadResult>('/api/feedback/screenshot', { image }, { signal });
  },

  /** Отправить обращение. */
  async send(payload: FeedbackPayload, signal?: AbortSignal): Promise<FeedbackResult> {
    return http.post<FeedbackResult>('/api/feedback', payload, { signal });
  },
};

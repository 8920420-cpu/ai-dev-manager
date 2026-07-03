/**
 * Виджет «Обратная связь» оркестратора — типы обращения и его автоконтекста.
 *
 * UX повторяет виджет ПС-чата (PROBLEM-REPORT-WIDGET-001 + FEEDBACK-CATEGORIES-001),
 * но отправка идёт в общий backend оркестратора (same-origin), который серверно
 * подставляет токен предзарегистрированной интеграции «orchestrator-ui» и переиспользует
 * приём обращений INTAKE-INTEGRATIONS-001 (задача сразу в BACKLOG под Приёмщиком,
 * data_card.source='intake-integration'). Секрет интеграции в бандл не попадает.
 */

/** Категория обращения (шаг 1 диалога). */
export type FeedbackCategory = 'bug' | 'idea' | 'feature' | 'question';

/**
 * Автоконтекст обращения. Контракт согласован с backend-приёмом
 * (normalizeIntakeReport). Все поля best-effort — сервер терпит их отсутствие.
 */
export interface FeedbackAutocontext {
  /** URL страницы, с которой отправлено обращение. */
  url: string | null;
  /** Версия сборки фронтенда (VITE_BUILD_VERSION), если задана. */
  buildVersion: string | null;
  /** User-Agent браузера. */
  userAgent: string | null;
  /** Момент отправки (ISO 8601). */
  timestamp: string | null;
  /** Последние перехваченные JS-ошибки (window.onerror / unhandledrejection). */
  jsErrors: string[];
  /** Идентификатор последнего упавшего API-запроса (если удалось получить). */
  lastFailedApiRequestId: string | null;
}

/** Тело обращения, отправляемое на POST /api/feedback. */
export interface FeedbackPayload {
  /** UUID обращения — генерирует виджет (идемпотентность на стороне приёма). */
  externalId: string;
  /** Текст пользователя. */
  message: string;
  /** Имя отправителя (в UI оркестратора нет аутентификации). */
  user: string;
  /** Категория обращения. */
  category: FeedbackCategory;
  /** Микросервис-источник — всегда «orchestrator-ui». */
  service: 'orchestrator-ui';
  /** Текущий раздел/маршрут SPA. */
  form: string;
  autocontext: FeedbackAutocontext;
  /** Ссылка на приложенный скриншот (через API оркестратора), если есть. */
  screenshotUrl?: string | null;
}

/** Ответ приёма обращения — переиспользует контракт acceptIntakeReport. */
export interface FeedbackResult {
  accepted?: boolean;
  duplicate?: boolean;
  /** Человекочитаемый номер заявки — показываем пользователю. */
  reportNumber: number | null;
  taskId?: string | null;
  externalId?: string;
}

/** Ответ загрузки скриншота через backend оркестратора. */
export interface ScreenshotUploadResult {
  id?: string;
  /** Ссылка на скриншот (GET /api/feedback/screenshot/:id), кладётся в обращение. */
  url: string;
}

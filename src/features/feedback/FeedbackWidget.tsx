import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Input, Textarea } from '../../components/ui/Field';
import { Stepper } from '../../components/ui/Stepper';
import { Callout } from '../../components/ui/Callout';
import { useToast } from '../../components/ui/Toast';
import { useRouter } from '../../app/router';
import { ApiError } from '../../api/http';
import { feedbackApi } from '../../api/feedbackApi';
import type { FeedbackCategory, FeedbackPayload } from '../../types/feedback';
import { captureScreenshot } from './captureScreenshot';
import { getRecentJsErrors, installJsErrorCapture } from './jsErrorBuffer';
import styles from './FeedbackWidget.module.css';

/** Ключ localStorage для имени отправителя и дефолт (аутентификации в UI нет). */
const USER_KEY = 'adm.feedback.user';
const DEFAULT_USER = 'orchestrator-ui';

/** Микросервис-источник обращений этого UI. */
const SERVICE = 'orchestrator-ui' as const;

/** Версия сборки для автоконтекста (если задана на этапе сборки). */
const BUILD_VERSION =
  (import.meta.env?.VITE_BUILD_VERSION as string | undefined)?.trim() || null;

/** Минимальная длина сообщения на клиенте (сервер может требовать больше). */
const MIN_MESSAGE_LEN = 5;

interface CategoryOption {
  value: FeedbackCategory;
  emoji: string;
  label: string;
}

/** Категории (шаг 1). Порядок и подписи повторяют ПС-виджет; bug — по умолчанию. */
const CATEGORIES: CategoryOption[] = [
  { value: 'bug', emoji: '🐞', label: 'Нашёл ошибку' },
  { value: 'idea', emoji: '💡', label: 'Идея' },
  { value: 'feature', emoji: '⚙️', label: 'Не хватает функции' },
  { value: 'question', emoji: '❓', label: 'Вопрос' },
];

const STEPS = [{ label: 'Категория' }, { label: 'Сообщение' }, { label: 'Проверка' }];

type Step = 'category' | 'details' | 'review' | 'done';

function loadUser(): string {
  try {
    return localStorage.getItem(USER_KEY) || DEFAULT_USER;
  } catch {
    return DEFAULT_USER;
  }
}

function persistUser(name: string): void {
  try {
    localStorage.setItem(USER_KEY, name);
  } catch {
    /* localStorage может быть недоступен — не критично */
  }
}

/** UUID для externalId: crypto.randomUUID при наличии, иначе безопасный fallback. */
function generateUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6]! & 0x0f) | 0x40;
      b[8] = (b[8]! & 0x3f) | 0x80;
      const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  } catch {
    /* падаем во fallback ниже */
  }
  return `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const CATEGORY_LABEL: Record<FeedbackCategory, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.value, `${c.emoji} ${c.label}`]),
) as Record<FeedbackCategory, string>;

/**
 * Плавающая кнопка «Обратная связь» + пошаговый диалог. Монтируется глобально,
 * поэтому доступна на любой странице SPA. Отправляет обращение в общий backend
 * оркестратора (POST /api/feedback), который создаёт задачу сразу в BACKLOG под
 * Приёмщиком.
 */
export function FeedbackWidget() {
  const toast = useToast();
  const { route } = useRouter();

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('category');
  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [message, setMessage] = useState('');
  const [attachScreenshot, setAttachScreenshot] = useState(false);
  const [name, setName] = useState<string>(loadUser);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reportNumber, setReportNumber] = useState<number | null>(null);
  const [showValidation, setShowValidation] = useState(false);

  // externalId стабилен для одного обращения (идемпотентность на ретраях);
  // уже загруженный скриншот переиспользуем, чтобы не грузить повторно.
  const externalIdRef = useRef<string>('');
  const screenshotUrlRef = useRef<string | null>(null);

  // Перехват JS-ошибок ставим один раз при монтировании виджета.
  useEffect(() => installJsErrorCapture(), []);

  const messageInvalid = message.trim().length < MIN_MESSAGE_LEN;

  const resetForm = useCallback(() => {
    setStep('category');
    setCategory('bug');
    setMessage('');
    setAttachScreenshot(false);
    setError(null);
    setReportNumber(null);
    setShowValidation(false);
    externalIdRef.current = '';
    screenshotUrlRef.current = null;
  }, []);

  const handleOpen = useCallback(() => {
    resetForm();
    externalIdRef.current = generateUuid();
    setName(loadUser());
    setOpen(true);
  }, [resetForm]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  const handleSend = useCallback(async () => {
    setSending(true);
    setError(null);
    try {
      // 1. Скриншот (если запрошен и ещё не загружен) — не критичен для приёма.
      let screenshotUrl = screenshotUrlRef.current;
      if (attachScreenshot && !screenshotUrl) {
        const dataUrl = await captureScreenshot();
        if (dataUrl) {
          try {
            const uploaded = await feedbackApi.uploadScreenshot(dataUrl);
            screenshotUrl = uploaded.url;
            screenshotUrlRef.current = uploaded.url;
          } catch {
            toast.warning('Не удалось приложить скриншот — обращение отправлено без него.');
          }
        } else {
          toast.warning('Не удалось сделать скриншот — обращение отправлено без него.');
        }
      }

      // 2. Имя отправителя — сохраняем на устройстве на будущее.
      const user = name.trim() || DEFAULT_USER;
      persistUser(user);

      const payload: FeedbackPayload = {
        externalId: externalIdRef.current,
        message: message.trim(),
        user,
        category,
        service: SERVICE,
        form: route,
        autocontext: {
          url: window.location.href,
          buildVersion: BUILD_VERSION,
          userAgent: navigator.userAgent,
          timestamp: new Date().toISOString(),
          jsErrors: getRecentJsErrors(),
          lastFailedApiRequestId: null,
        },
        ...(screenshotUrl ? { screenshotUrl } : {}),
      };

      const result = await feedbackApi.send(payload);
      setReportNumber(result.reportNumber ?? null);
      setStep('done');
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : 'Не удалось отправить обращение. Проверьте связь и повторите.';
      setError(msg);
    } finally {
      setSending(false);
    }
  }, [attachScreenshot, category, message, name, route, toast]);

  const goDetailsNext = useCallback(() => {
    if (messageInvalid) {
      setShowValidation(true);
      return;
    }
    setShowValidation(false);
    setStep('review');
  }, [messageInvalid]);

  // ---- Рендер шагов ------------------------------------------------------

  const renderCategory = () => (
    <fieldset className={styles.categoryFieldset}>
      <legend className={styles.legend}>С чем связано обращение?</legend>
      <div className={styles.categoryGrid} role="radiogroup" aria-label="Категория обращения">
        {CATEGORIES.map((opt) => (
          <label
            key={opt.value}
            className={styles.categoryOption}
            data-selected={category === opt.value || undefined}
          >
            <input
              type="radio"
              name="feedback-category"
              className={styles.categoryRadio}
              value={opt.value}
              checked={category === opt.value}
              onChange={() => setCategory(opt.value)}
            />
            <span className={styles.categoryEmoji} aria-hidden="true">
              {opt.emoji}
            </span>
            <span className={styles.categoryLabel}>{opt.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );

  const renderDetails = () => (
    <div className={styles.stepBody}>
      <Textarea
        label="Сообщение"
        required
        rows={5}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Опишите проблему, идею или вопрос…"
        error={showValidation && messageInvalid ? `Минимум ${MIN_MESSAGE_LEN} символов.` : null}
      />
      <label className={styles.checkboxRow}>
        <input
          type="checkbox"
          checked={attachScreenshot}
          onChange={(e) => {
            setAttachScreenshot(e.target.checked);
            // При выключении сбрасываем ранее загруженный скриншот.
            if (!e.target.checked) screenshotUrlRef.current = null;
          }}
        />
        <span>Приложить скриншот текущего экрана</span>
      </label>
      <Input
        label="Ваше имя"
        optional
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={DEFAULT_USER}
        helper="Сохраняется на этом устройстве и подставляется в следующие обращения."
      />
    </div>
  );

  const renderReview = () => (
    <div className={styles.stepBody}>
      <p className={styles.reviewIntro}>Проверьте данные перед отправкой:</p>
      <dl className={styles.reviewList}>
        <div className={styles.reviewRow}>
          <dt>Категория</dt>
          <dd>{CATEGORY_LABEL[category]}</dd>
        </div>
        <div className={styles.reviewRow}>
          <dt>Сообщение</dt>
          <dd className={styles.reviewMessage}>{message.trim()}</dd>
        </div>
        <div className={styles.reviewRow}>
          <dt>Скриншот</dt>
          <dd>{attachScreenshot ? 'Будет приложен' : 'Нет'}</dd>
        </div>
        <div className={styles.reviewRow}>
          <dt>Имя</dt>
          <dd>{name.trim() || DEFAULT_USER}</dd>
        </div>
        <div className={styles.reviewRow}>
          <dt>Раздел</dt>
          <dd className="mono">{route}</dd>
        </div>
      </dl>
      {error && (
        <Callout tone="error" title="Ошибка отправки" live>
          {error}
        </Callout>
      )}
    </div>
  );

  const renderDone = () => (
    <div className={styles.doneBody}>
      <div className={styles.doneEmoji} aria-hidden="true">
        ✅
      </div>
      <p className={styles.doneTitle}>
        {reportNumber != null ? `Заявка №${reportNumber} принята` : 'Обращение принято'}
      </p>
      <p className={styles.doneHint}>
        Спасибо! Обращение передано на обработку и появится в работе Приёмщика.
      </p>
    </div>
  );

  const currentIndex = step === 'category' ? 0 : step === 'details' ? 1 : 2;

  let footer: React.ReactNode = null;
  if (step === 'category') {
    footer = (
      <>
        <Button variant="ghost" onClick={handleClose}>
          Отмена
        </Button>
        <Button variant="primary" onClick={() => setStep('details')}>
          Далее
        </Button>
      </>
    );
  } else if (step === 'details') {
    footer = (
      <>
        <Button variant="ghost" onClick={() => setStep('category')}>
          Назад
        </Button>
        <Button variant="primary" onClick={goDetailsNext} disabled={messageInvalid}>
          Далее
        </Button>
      </>
    );
  } else if (step === 'review') {
    footer = (
      <>
        <Button variant="ghost" onClick={() => setStep('details')} disabled={sending}>
          Назад
        </Button>
        <Button variant="primary" onClick={handleSend} loading={sending}>
          Отправить
        </Button>
      </>
    );
  } else {
    footer = (
      <Button variant="primary" onClick={handleClose}>
        Закрыть
      </Button>
    );
  }

  return (
    <>
      <button
        type="button"
        className={styles.fab}
        onClick={handleOpen}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <MessageSquarePlus size={18} aria-hidden="true" />
        <span className={styles.fabLabel}>Обратная связь</span>
      </button>

      <Modal open={open} onClose={handleClose} title="Обратная связь" size="md" footer={footer}>
        {step !== 'done' && <Stepper steps={STEPS} current={currentIndex} />}
        {step === 'category' && renderCategory()}
        {step === 'details' && renderDetails()}
        {step === 'review' && renderReview()}
        {step === 'done' && renderDone()}
      </Modal>
    </>
  );
}

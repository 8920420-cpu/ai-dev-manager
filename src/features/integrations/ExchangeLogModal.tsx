import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ScrollText } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  LoadingBlock,
  Modal,
  type BadgeTone,
} from '../../components/ui';
import { integrationsApi } from '../../api/integrationsApi';
import { formatDateTime } from '../../lib/format';
import type { Integration, PromptExchange } from '../../types/integration';
import styles from './ExchangeLogModal.module.css';

interface ExchangeLogModalProps {
  open: boolean;
  onClose: () => void;
  integration: Integration | null;
}

type LoadState = 'loading' | 'error' | 'ready';

const STATUS_TONE: Record<string, BadgeTone> = {
  Создан: 'neutral',
  отправлен: 'info',
  завершен: 'success',
  ошибка: 'danger',
};

export function ExchangeLogModal({ open, onClose, integration }: ExchangeLogModalProps) {
  const [items, setItems] = useState<PromptExchange[]>([]);
  const [state, setState] = useState<LoadState>('loading');

  const load = useCallback(async () => {
    if (!integration) return;
    setState('loading');
    try {
      setItems(await integrationsApi.exchanges(integration.id));
      setState('ready');
    } catch {
      setState('error');
    }
  }, [integration]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Журнал обмена — ${integration?.name ?? ''}`}
      subtitle="Структурированный лог промтов и ответов через эту интеграцию"
      size="lg"
      footerStart={
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<RefreshCw size={15} aria-hidden="true" />}
          onClick={() => void load()}
          disabled={state === 'loading'}
        >
          Обновить
        </Button>
      }
      footer={
        <Button variant="secondary" onClick={onClose}>
          Закрыть
        </Button>
      }
    >
      {state === 'loading' && <LoadingBlock label="Загрузка журнала…" />}

      {state === 'error' && (
        <EmptyState
          tone="error"
          icon={<ScrollText size={28} aria-hidden="true" />}
          title="Не удалось загрузить журнал"
          description="Произошла ошибка при получении записей обмена."
          action={
            <Button variant="secondary" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      )}

      {state === 'ready' && items.length === 0 && (
        <EmptyState
          icon={<ScrollText size={28} aria-hidden="true" />}
          title="Обменов пока нет"
          description="Здесь появятся записи после первого вызова ИИ через эту интеграцию."
        />
      )}

      {state === 'ready' && items.length > 0 && (
        <ul className={styles.list}>
          {items.map((ex) => (
            <li key={ex.id} className={styles.item}>
              <div className={styles.head}>
                <Badge tone={STATUS_TONE[ex.status] ?? 'neutral'}>{ex.status}</Badge>
                <span className={styles.time}>{formatDateTime(ex.createdAt)}</span>
                {ex.durationMs != null && (
                  <span className={styles.meta}>{ex.durationMs} мс</span>
                )}
                {ex.httpStatus != null && (
                  <span className={styles.meta}>HTTP {ex.httpStatus}</span>
                )}
                {ex.isManual && <span className={styles.meta}>ручной</span>}
              </div>

              {ex.prompt && (
                <details className={styles.block}>
                  <summary className={styles.summary}>Промт</summary>
                  <pre className={styles.pre}>{ex.prompt}</pre>
                </details>
              )}

              {ex.response && (
                <details className={styles.block} open>
                  <summary className={styles.summary}>Ответ</summary>
                  <pre className={styles.pre}>{ex.response}</pre>
                </details>
              )}

              {ex.error && (
                <pre className={`${styles.pre} ${styles.error}`}>{ex.error}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

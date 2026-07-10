import { useEffect, useState } from 'react';
import { Activity, Pencil, ScrollText, Send } from 'lucide-react';
import {
  Button,
  Callout,
  ConnectionBadge,
  Modal,
  Textarea,
  useToast,
} from '../../components/ui';
import { integrationsApi } from '../../api/integrationsApi';
import { formatDateTime } from '../../lib/format';
import type { ConnectionState } from '../../types/common';
import type { Integration } from '../../types/integration';
import { ExchangeLogModal } from './ExchangeLogModal';
import styles from './IntegrationDetailModal.module.css';

interface IntegrationDetailModalProps {
  open: boolean;
  onClose: () => void;
  integration: Integration | null;
  /** Открыть форму редактирования. */
  onEdit: (integration: Integration) => void;
  /** Обновить запись в списке (после проверки). */
  onUpdated: (integration: Integration) => void;
}

export function IntegrationDetailModal({
  open,
  onClose,
  integration,
  onEdit,
  onUpdated,
}: IntegrationDetailModalProps) {
  const toast = useToast();
  const [logOpen, setLogOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<ConnectionState>('unknown');
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStatus(integration?.status ?? 'unknown');
    setPrompt('');
    setAnswer(null);
    setSending(false);
    setChecking(false);
  }, [open, integration]);

  if (!integration) return null;

  async function handleCheck() {
    if (checking || !integration) return;
    setChecking(true);
    setStatus('checking');
    try {
      const result = await integrationsApi.checkConnection(integration.id);
      setStatus(result.state);
      onUpdated({ ...integration, status: result.state, lastCheckedAt: result.checkedAt });
      if (result.state === 'success') toast.success(result.message ?? 'Коннектор отвечает');
      else toast.error(result.message ?? 'Коннектор недоступен');
    } finally {
      setChecking(false);
    }
  }

  async function handleSend() {
    if (sending || !integration || prompt.trim() === '') return;
    setSending(true);
    setAnswer(null);
    try {
      const r = await integrationsApi.invoke(integration.id, prompt.trim());
      setAnswer(r.response);
      setStatus('success');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка вызова');
      setStatus('error');
    } finally {
      setSending(false);
    }
  }

  const model = integration.model.trim() || 'по умолчанию';

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={integration.name}
        subtitle="Параметры коннектора AI-провайдера"
        size="md"
        footerStart={
          <Button
            variant="secondary"
            leftIcon={<ScrollText size={16} aria-hidden="true" />}
            onClick={() => setLogOpen(true)}
          >
            Лог
          </Button>
        }
        footer={
          <>
            <Button
              variant="ghost"
              leftIcon={<Pencil size={16} aria-hidden="true" />}
              onClick={() => onEdit(integration)}
            >
              Изменить
            </Button>
            <Button
              variant="primary"
              leftIcon={<Activity size={16} aria-hidden="true" />}
              loading={checking}
              onClick={handleCheck}
            >
              Проверить
            </Button>
          </>
        }
      >
        <dl className={styles.grid}>
          <div className={styles.row}>
            <dt className={styles.term}>Провайдер</dt>
            <dd className={styles.def}>{integration.provider}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.term}>Endpoint</dt>
            <dd className={`${styles.def} ${styles.mono}`}>{integration.endpoint}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.term}>Модель</dt>
            <dd className={`${styles.def} ${styles.mono}`}>{model}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.term}>Access token</dt>
            <dd className={styles.def}>{integration.hasToken ? 'Задан' : 'Не задан'}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.term}>Состояние</dt>
            <dd className={styles.def}>
              <ConnectionBadge state={status} />
            </dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.term}>Создан</dt>
            <dd className={styles.def}>{formatDateTime(integration.createdAt)}</dd>
          </div>
        </dl>

        <div className={styles.tester}>
          <Textarea
            label="Тестовый промт"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Напишите промт и отправьте через коннектор…"
          />
          <div className={styles.testerActions}>
            <Button
              variant="secondary"
              leftIcon={<Send size={16} aria-hidden="true" />}
              loading={sending}
              disabled={prompt.trim() === ''}
              onClick={handleSend}
            >
              Отправить
            </Button>
          </div>
          {answer != null && (
            <Callout tone="success" title="Ответ">
              <pre className={styles.answer}>{answer}</pre>
            </Callout>
          )}
        </div>
      </Modal>

      <ExchangeLogModal open={logOpen} onClose={() => setLogOpen(false)} integration={integration} />
    </>
  );
}

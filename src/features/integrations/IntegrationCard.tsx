import { useState } from 'react';
import { Activity, Clock, Pencil, Plug, ScrollText, Trash2 } from 'lucide-react';
import {
  Button,
  Card,
  ConfirmDialog,
  ConnectionBadge,
  Menu,
  useToast,
  type MenuItem,
} from '../../components/ui';
import { integrationsApi } from '../../api/integrationsApi';
import { formatDateTime } from '../../lib/format';
import type { ConnectionState } from '../../types/common';
import type { Integration } from '../../types/integration';
import styles from './IntegrationCard.module.css';

interface IntegrationCardProps {
  integration: Integration;
  /** Открыть модалку с деталями + журналом обмена. */
  onOpen: (integration: Integration) => void;
  /** Открыть модалку редактирования. */
  onEdit: (integration: Integration) => void;
  /** Локально обновить запись в списке после изменения. */
  onUpdated: (integration: Integration) => void;
  /** Удалить запись из списка. */
  onRemoved: (id: string) => void;
}

export function IntegrationCard({
  integration,
  onOpen,
  onEdit,
  onUpdated,
  onRemoved,
}: IntegrationCardProps) {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const displayState: ConnectionState = checking
    ? 'checking'
    : integration.status ?? 'unknown';

  async function handleCheck() {
    if (checking) return;
    setChecking(true);
    try {
      const result = await integrationsApi.checkConnection(integration.id);
      onUpdated({ ...integration, status: result.state, lastCheckedAt: result.checkedAt });
      const message = result.message ?? 'Проверка завершена';
      if (result.state === 'success') toast.success(message);
      else toast.error(message);
    } catch {
      toast.error('Не удалось выполнить проверку соединения');
    } finally {
      setChecking(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      await integrationsApi.remove(integration.id);
      onRemoved(integration.id);
      setConfirmOpen(false);
      toast.success(`Интеграция «${integration.name}» удалена`);
    } catch {
      toast.error('Не удалось удалить интеграцию');
      setRemoving(false);
    }
  }

  const menuItems: MenuItem[] = [
    {
      label: 'Открыть',
      icon: <ScrollText size={16} aria-hidden="true" />,
      onSelect: () => onOpen(integration),
    },
    {
      label: 'Проверить соединение',
      icon: <Activity size={16} aria-hidden="true" />,
      onSelect: handleCheck,
      disabled: checking,
    },
    {
      label: 'Изменить',
      icon: <Pencil size={16} aria-hidden="true" />,
      onSelect: () => onEdit(integration),
    },
    {
      label: 'Удалить',
      icon: <Trash2 size={16} aria-hidden="true" />,
      onSelect: () => setConfirmOpen(true),
      tone: 'danger',
    },
  ];

  return (
    <Card className={styles.card}>
      <div className={styles.head}>
        <div className={styles.titleWrap}>
          <span className={styles.name} title={integration.name}>
            {integration.name}
          </span>
          <span className={styles.url} title={integration.endpoint}>
            <Plug size={13} aria-hidden="true" />
            {integration.provider}
          </span>
        </div>
        <Menu items={menuItems} label={`Действия: ${integration.name}`} />
      </div>

      <div className={styles.meta}>
        <ConnectionBadge state={displayState} />
        <span className={styles.checked}>
          <Clock size={13} className={styles.checkedIcon} aria-hidden="true" />
          {integration.lastCheckedAt
            ? formatDateTime(integration.lastCheckedAt)
            : '—'}
        </span>
      </div>

      <div className={styles.footer}>
        <Button
          variant="primary"
          size="sm"
          leftIcon={<ScrollText size={15} aria-hidden="true" />}
          onClick={() => onOpen(integration)}
        >
          Открыть
        </Button>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Activity size={15} aria-hidden="true" />}
          loading={checking}
          onClick={handleCheck}
        >
          Проверить
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Удалить интеграцию?"
        description={
          <>
            Интеграция «{integration.name}» будет удалена. Это действие нельзя
            отменить.
          </>
        }
        confirmLabel="Удалить"
        cancelLabel="Отмена"
        tone="danger"
        loading={removing}
        onConfirm={handleRemove}
        onCancel={() => setConfirmOpen(false)}
      />
    </Card>
  );
}

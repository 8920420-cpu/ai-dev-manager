import { useCallback, useEffect, useState } from 'react';
import { Plug, Plus } from 'lucide-react';
import {
  Button,
  EmptyState,
  LoadingBlock,
  PageHeader,
} from '../../components/ui';
import { integrationsApi } from '../../api/integrationsApi';
import type { Integration } from '../../types/integration';
import { IntegrationCard } from './IntegrationCard';
import { IntegrationFormModal } from './IntegrationFormModal';
import { IntegrationDetailModal } from './IntegrationDetailModal';
import styles from './IntegrationsPage.module.css';

type LoadState = 'loading' | 'error' | 'ready';

export function IntegrationsPage() {
  const [items, setItems] = useState<Integration[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Integration | null>(null);
  const [detail, setDetail] = useState<Integration | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const list = await integrationsApi.list();
      setItems(list);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(integration: Integration) {
    setDetail(null);
    setEditing(integration);
    setModalOpen(true);
  }

  function openDetail(integration: Integration) {
    setDetail(integration);
  }

  function handleSaved(saved: Integration, isNew: boolean) {
    setItems((list) => {
      const exists = list.some((i) => i.id === saved.id);
      const next = exists
        ? list.map((i) => (i.id === saved.id ? saved : i))
        : [...list, saved];
      return next.sort((a, b) => a.name.localeCompare(b.name));
    });
    // После создания подключения сразу открываем его детали + журнал.
    if (isNew) setDetail(saved);
  }

  function handleUpdated(updated: Integration) {
    setItems((list) => list.map((i) => (i.id === updated.id ? updated : i)));
    setDetail((d) => (d && d.id === updated.id ? updated : d));
  }

  function handleRemoved(id: string) {
    setItems((list) => list.filter((i) => i.id !== id));
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="Интеграции"
        description="Коннекторы AI-провайдеров и сервисов, к которым подключается оркестратор."
        actions={
          <Button
            variant="primary"
            leftIcon={<Plus size={16} aria-hidden="true" />}
            onClick={openCreate}
          >
            Добавить интеграцию
          </Button>
        }
      />

      {state === 'loading' && <LoadingBlock label="Загрузка интеграций…" />}

      {state === 'error' && (
        <EmptyState
          tone="error"
          icon={<Plug size={28} aria-hidden="true" />}
          title="Не удалось загрузить интеграции"
          description="Произошла ошибка при получении списка коннекторов."
          action={
            <Button variant="secondary" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      )}

      {state === 'ready' && items.length === 0 && (
        <EmptyState
          icon={<Plug size={28} aria-hidden="true" />}
          title="Интеграций пока нет"
          description="Добавьте первый коннектор AI-провайдера или сервиса, чтобы оркестратор мог к нему подключаться."
          action={
            <Button
              variant="primary"
              leftIcon={<Plus size={16} aria-hidden="true" />}
              onClick={openCreate}
            >
              Добавить интеграцию
            </Button>
          }
        />
      )}

      {state === 'ready' && items.length > 0 && (
        <div className={styles.grid}>
          {items.map((integration) => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              onOpen={openDetail}
              onEdit={openEdit}
              onUpdated={handleUpdated}
              onRemoved={handleRemoved}
            />
          ))}
        </div>
      )}

      <IntegrationFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        initial={editing}
        onSaved={handleSaved}
      />

      <IntegrationDetailModal
        open={detail !== null}
        onClose={() => setDetail(null)}
        integration={detail}
        onEdit={openEdit}
        onUpdated={handleUpdated}
      />
    </div>
  );
}

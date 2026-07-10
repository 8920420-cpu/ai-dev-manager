import { useEffect, useState } from 'react';
import { Database, Plus } from 'lucide-react';
import {
  Button,
  Callout,
  EmptyState,
  LoadingBlock,
  Section,
} from '../../components/ui';
import { databaseConnectionsApi } from '../../api/databaseConnectionsApi';
import type { DbConnection } from '../../types/settings';
import { DbConnectionCard } from './DbConnectionCard';
import { DbConnectionFormModal } from './DbConnectionFormModal';
import styles from './DatabaseConnectionsSection.module.css';

type LoadState = 'loading' | 'error' | 'ready';

/**
 * Единый экран подключений к БД: список карточек + действие «Подключить».
 * Без категорий «основная»/«дополнительная». CRUD и тест — через единый API
 * (`/api/database-connections`). Ошибка одной БД не скрывает остальные карточки
 * и не блокирует создание нового подключения.
 */
export function DatabaseConnectionsSection() {
  const [state, setState] = useState<LoadState>('loading');
  const [connections, setConnections] = useState<DbConnection[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<DbConnection | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    let active = true;
    setState('loading');
    databaseConnectionsApi
      .list(ctrl.signal)
      .then((list) => {
        if (!active) return;
        setConnections(list);
        setState('ready');
      })
      .catch((err) => {
        if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
          return;
        }
        if (active) setState('error');
      });
    return () => {
      active = false;
      ctrl.abort();
    };
  }, []);

  function openCreate() {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(connection: DbConnection) {
    setEditing(connection);
    setModalOpen(true);
  }

  function handleSaved(saved: DbConnection) {
    setConnections((prev) => {
      const exists = prev.some((c) => c.id === saved.id);
      const next = exists ? prev.map((c) => (c.id === saved.id ? saved : c)) : [...prev, saved];
      return next.sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  function handleRemoved(id: string) {
    setConnections((prev) => prev.filter((c) => c.id !== id));
  }

  function reload() {
    setState('loading');
    databaseConnectionsApi
      .list()
      .then((list) => {
        setConnections(list);
        setState('ready');
      })
      .catch(() => setState('error'));
  }

  const connectButton = (
    <Button
      variant="primary"
      leftIcon={<Plus size={16} aria-hidden="true" />}
      onClick={openCreate}
    >
      Подключить
    </Button>
  );

  return (
    <Section
      title="Базы данных"
      description="Подключения к базам данных, доступные для выбора в проектах. Каждое подключение — отдельная карточка; пароль хранится только на сервере."
      id="database-connections"
      actions={connectButton}
    >
      {state === 'loading' && <LoadingBlock label="Загрузка подключений…" />}

      {state === 'error' && (
        <Callout tone="error" title="Не удалось загрузить подключения" live>
          Backend оркестратора недоступен (<code>/api/database-connections</code>).{' '}
          <Button variant="secondary" size="sm" onClick={reload}>
            Повторить
          </Button>
        </Callout>
      )}

      {state === 'ready' && connections.length === 0 && (
        <EmptyState
          icon={<Database size={28} aria-hidden="true" />}
          title="Подключений пока нет"
          description="Добавьте подключение к базе данных, чтобы выбирать его при настройке проектов."
          action={connectButton}
        />
      )}

      {state === 'ready' && connections.length > 0 && (
        <ul className={styles.list}>
          {connections.map((connection) => (
            <DbConnectionCard
              key={connection.id}
              connection={connection}
              onEdit={openEdit}
              onRemoved={handleRemoved}
            />
          ))}
        </ul>
      )}

      <DbConnectionFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        initial={editing}
        onSaved={handleSaved}
      />
    </Section>
  );
}

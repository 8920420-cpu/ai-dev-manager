import { useState } from 'react';
import { Activity, Database, Pencil, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  useToast,
} from '../../components/ui';
import {
  databaseConnectionsApi,
  DbConnectionInUseError,
} from '../../api/databaseConnectionsApi';
import { DBMS_LABEL, type DbConnection, type DbConnectionDependent } from '../../types/settings';
import styles from './DbConnectionCard.module.css';

interface DbConnectionCardProps {
  connection: DbConnection;
  onEdit: (connection: DbConnection) => void;
  onRemoved: (id: string) => void;
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok' }
  | { kind: 'error'; error: string };

/**
 * Карточка одного подключения к БД. Без признаков «основная»/«дополнительная».
 * Показывает имя, тип СУБД, адрес/имя БД и статус последней проверки. Секрет не
 * отображается. Ошибка одной БД не влияет на остальные карточки.
 */
export function DbConnectionCard({ connection, onEdit, onRemoved }: DbConnectionCardProps) {
  const toast = useToast();
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  /** Конфликт удаления: подключение используется проектами. */
  const [conflict, setConflict] = useState<DbConnectionDependent[] | null>(null);

  async function handleTest() {
    if (test.kind === 'checking') return;
    setTest({ kind: 'checking' });
    try {
      const result = await databaseConnectionsApi.test(connection.id);
      if (result.connected) {
        setTest({ kind: 'ok' });
        toast.success(`Подключение «${connection.name}» доступно`);
      } else {
        setTest({ kind: 'error', error: result.error ?? 'Не удалось подключиться' });
      }
    } catch (e) {
      setTest({
        kind: 'error',
        error: e instanceof Error ? e.message : 'Ошибка проверки соединения',
      });
    }
  }

  async function handleRemove() {
    setRemoving(true);
    setConflict(null);
    try {
      await databaseConnectionsApi.remove(connection.id);
      onRemoved(connection.id);
      setConfirmOpen(false);
      toast.success(`Подключение «${connection.name}» удалено`);
    } catch (e) {
      if (e instanceof DbConnectionInUseError) {
        // Не обнуляем ссылки молча — показываем серверную информацию о конфликте.
        setConflict(e.dependents);
        setConfirmOpen(false);
      } else {
        toast.error(e instanceof Error ? e.message : 'Не удалось удалить подключение');
      }
      setRemoving(false);
    }
  }

  return (
    <li className={styles.card}>
      <div className={styles.head}>
        <span className={styles.title} title={connection.name}>
          <Database size={16} aria-hidden="true" />
          {connection.name || 'Без названия'}
        </span>
        <Badge tone="neutral">{DBMS_LABEL[connection.dbmsType] ?? connection.dbmsType}</Badge>
      </div>

      <dl className={styles.grid}>
        <Field label="Адрес" value={`${connection.host}:${connection.port}`} mono />
        <Field label="База данных" value={connection.database} mono />
        <Field label="Пользователь" value={connection.user} mono />
        <Field label="Пароль" value={connection.hasSecret ? 'Задан на сервере' : 'Не задан'} />
      </dl>

      <div className={styles.statusRow} aria-live="polite">
        {test.kind === 'idle' && (
          <span className={styles.statusMuted}>Соединение ещё не проверялось</span>
        )}
        {test.kind === 'checking' && <span className={styles.statusMuted}>Проверка…</span>}
        {test.kind === 'ok' && <Badge tone="success">Подключение доступно</Badge>}
        {test.kind === 'error' && (
          <Badge tone="danger">Нет связи: {test.error}</Badge>
        )}
      </div>

      {conflict && (
        <Callout tone="warning" title="Подключение используется проектами" live>
          Удаление невозможно: подключение используют{' '}
          {conflict.length > 0 ? (
            <>проекты {conflict.map((d) => d.name || d.code).join(', ')}</>
          ) : (
            'другие проекты'
          )}
          . Сначала отвяжите подключение в этих проектах.
        </Callout>
      )}

      <div className={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Activity size={15} aria-hidden="true" />}
          loading={test.kind === 'checking'}
          onClick={handleTest}
        >
          Проверить
        </Button>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<Pencil size={15} aria-hidden="true" />}
          onClick={() => onEdit(connection)}
        >
          Изменить
        </Button>
        <Button
          variant="dangerGhost"
          size="sm"
          leftIcon={<Trash2 size={15} aria-hidden="true" />}
          onClick={() => setConfirmOpen(true)}
          aria-label={`Удалить подключение «${connection.name}»`}
        >
          Удалить
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Удалить подключение?"
        description={
          <>
            Подключение «{connection.name}» будет удалено. Это действие нельзя отменить.
          </>
        }
        confirmLabel="Удалить"
        cancelLabel="Отмена"
        tone="danger"
        loading={removing}
        onConfirm={handleRemove}
        onCancel={() => setConfirmOpen(false)}
      />
    </li>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.field}>
      <dt className={styles.fieldLabel}>{label}</dt>
      <dd className={mono ? styles.fieldValueMono : styles.fieldValue}>{value || '—'}</dd>
    </div>
  );
}

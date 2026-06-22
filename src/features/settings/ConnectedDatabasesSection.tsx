import { useEffect, useState } from 'react';
import { Database, RefreshCw } from 'lucide-react';
import { Badge, Button, Callout, LoadingBlock, Section } from '../../components/ui';
import { databasesApi } from '../../api/databasesApi';
import { PG_SSL_LABEL, type ConnectedDatabase } from '../../types/settings';
import styles from './settings.module.css';

type LoadState = 'loading' | 'error' | 'ready';

/**
 * Секция «Подключённые базы данных»: РЕАЛЬНЫЕ подключения с backend
 * (`GET /api/databases`) с живым статусом. Только для чтения — параметры
 * задаются в секции PostgreSQL ниже или через переменные окружения сервера.
 */
export function ConnectedDatabasesSection() {
  const [state, setState] = useState<LoadState>('loading');
  const [rows, setRows] = useState<ConnectedDatabase[]>([]);
  // Инкремент → перезапрос (кнопка «Обновить»).
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    let active = true;
    setState('loading');
    databasesApi
      .listConnected(ctrl.signal)
      .then((list) => {
        if (!active) return;
        setRows(list);
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
  }, [reloadKey]);

  return (
    <Section
      title="Подключённые базы данных"
      description="Реальные подключения оркестратора с сервера и их текущий статус. Параметры задаются ниже (PostgreSQL) или через переменные окружения."
      id="connected-databases"
      actions={
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<RefreshCw size={16} aria-hidden="true" />}
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={state === 'loading'}
        >
          Обновить
        </Button>
      }
    >
      {state === 'loading' && <LoadingBlock label="Загрузка подключённых баз данных…" />}

      {state === 'error' && (
        <Callout tone="error" title="Не удалось получить список баз данных">
          Backend оркестратора недоступен. Проверьте, что сервис запущен и доступен по
          адресу <code>/api/databases</code>.
        </Callout>
      )}

      {state === 'ready' && rows.length === 0 && (
        <Callout tone="info" title="Нет подключённых баз данных">
          Backend не вернул ни одного подключения.
        </Callout>
      )}

      {state === 'ready' && rows.length > 0 && (
        <ul className={styles.dbList}>
          {rows.map((db) => (
            <li key={db.id} className={styles.dbCard}>
              <div className={styles.dbCardHead}>
                <span className={styles.dbCardTitle}>
                  <Database size={16} aria-hidden="true" />
                  {db.name}
                </span>
                <Badge tone={db.status.connected ? 'success' : 'danger'}>
                  {db.status.connected ? 'Подключено' : 'Нет связи'}
                </Badge>
              </div>

              <div className={styles.dbGrid}>
                <ReadField label="Адрес сервера" value={`${db.host}:${db.port}`} mono />
                <ReadField label="База данных" value={db.database} mono />
                <ReadField label="Имя пользователя" value={db.user} mono />
                <ReadField label="Режим SSL" value={PG_SSL_LABEL[db.sslMode] ?? db.sslMode} />
                <ReadField label="Пароль" value={db.hasPassword ? 'Задан на сервере' : 'Не задан'} />
                <ReadField
                  label="Таблиц в схеме"
                  value={db.status.tables == null ? '—' : String(db.status.tables)}
                />
              </div>

              {!db.status.connected && db.status.error && (
                <Callout tone="warning" title="Ошибка подключения" live>
                  {db.status.error}
                </Callout>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ReadField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.dbField}>
      <span className={styles.dbFieldLabel}>{label}</span>
      <span className={mono ? styles.dbFieldValueMono : styles.dbFieldValue}>{value}</span>
    </div>
  );
}

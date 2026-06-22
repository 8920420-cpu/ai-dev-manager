import { useEffect, useState } from 'react';
import { Database } from 'lucide-react';
import { Callout, LoadingBlock, Select, useToast } from '../../components/ui';
import {
  databasesApi,
  PRIMARY_DB_ID,
  type SelectableDatabase,
} from '../../api/databasesApi';
import styles from './StepDatabase.module.css';

interface StepDatabaseProps {
  databaseId: string | null;
  onChange: (databaseId: string | null) => void;
}

/**
 * Шаг 3: подключение к базе данных.
 * Если в настройках доступна только одна БД — она выбирается по умолчанию,
 * без выпадающего списка. Если несколько — пользователь выбирает нужную.
 */
export function StepDatabase({ databaseId, onChange }: StepDatabaseProps) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [databases, setDatabases] = useState<SelectableDatabase[]>([]);

  useEffect(() => {
    let active = true;
    databasesApi
      .listSelectable()
      .then((list) => {
        if (!active) return;
        setDatabases(list);
        // Авто-выбор: единственная БД — берём её; иначе подставляем основную,
        // если ничего ещё не выбрано или выбранная больше не существует.
        const exists = databaseId && list.some((d) => d.id === databaseId);
        if (!exists) {
          const fallback =
            list.find((d) => d.id === PRIMARY_DB_ID)?.id ?? list[0]?.id ?? null;
          onChange(fallback);
        }
      })
      .catch(() => {
        if (active) toast.error('Не удалось загрузить список баз данных');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div className={styles.step}>
        <LoadingBlock label="Загрузка баз данных…" />
      </div>
    );
  }

  const single = databases.length === 1;
  const selected = databases.find((d) => d.id === databaseId) ?? null;

  return (
    <div className={styles.step}>
      <div className={styles.head}>
        <h3 className={styles.title}>Подключение к базе данных</h3>
        <p className={styles.desc}>
          Выберите базу данных, к которой будет подключён проект. Управлять списком
          можно в разделе «Настройки → Базы данных».
        </p>
      </div>

      {databases.length === 0 ? (
        <Callout tone="warning" title="Нет доступных баз данных">
          Сначала настройте подключение в разделе «Настройки → Базы данных».
        </Callout>
      ) : single ? (
        <Callout tone="info" title="Будет использована единственная база данных">
          <span className={styles.singleName}>
            <Database size={16} aria-hidden="true" />
            {selected?.name}
          </span>
          <br />В настройках задана только одна база данных — проект подключится к
          ней по умолчанию.
        </Callout>
      ) : (
        <Select
          label="База данных"
          value={databaseId ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
        >
          {databases.map((db) => (
            <option key={db.id} value={db.id}>
              {db.name}
              {db.kind === 'primary' ? ' (основная)' : ''}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}

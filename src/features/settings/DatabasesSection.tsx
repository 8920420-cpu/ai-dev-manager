import { useEffect, useMemo, useState } from 'react';
import { Database, Plus, Save, Trash2 } from 'lucide-react';
import {
  Button,
  Callout,
  Input,
  LoadingBlock,
  Section,
  Select,
  useToast,
} from '../../components/ui';
import { databasesApi } from '../../api/databasesApi';
import { required, validHost, validPort } from '../../lib/validation';
import {
  PG_SSL_LABEL,
  type DatabaseConnection,
  type PgSslMode,
} from '../../types/settings';
import styles from './settings.module.css';

const SSL_MODES = Object.keys(PG_SSL_LABEL) as PgSslMode[];

/**
 * Секция «Дополнительные базы данных»: список именованных подключений.
 * ⚠️ Хранится локально (databasesApi → localStorage), БЕЗ пароля.
 * Пароли/секреты задаются на стороне backend (BACKEND_REQUIRED).
 */
export function DatabasesSection() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<DatabaseConnection[]>([]);
  /** Показывать ошибки только после попытки сохранить. */
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    let active = true;
    databasesApi
      .list()
      .then((list) => {
        if (active) setRows(list);
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

  const errorsByRow = useMemo(() => {
    const map = new Map<string, Partial<Record<keyof DatabaseConnection, string>>>();
    for (const row of rows) {
      map.set(row.id, {
        name: required(row.name, 'Название') ?? undefined,
        host: validHost(row.host) ?? undefined,
        port: validPort(String(row.port)) ?? undefined,
        database: required(row.database, 'База данных') ?? undefined,
        user: required(row.user, 'Имя пользователя') ?? undefined,
      });
    }
    return map;
  }, [rows]);

  const hasErrors = useMemo(
    () =>
      [...errorsByRow.values()].some((e) =>
        Object.values(e).some((msg) => Boolean(msg)),
      ),
    [errorsByRow],
  );

  function updateRow(id: string, patch: Partial<DatabaseConnection>) {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function addRow() {
    setRows((prev) => [...prev, databasesApi.make()]);
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((row) => row.id !== id));
  }

  async function handleSave() {
    setSubmitted(true);
    if (hasErrors) {
      toast.error('Исправьте ошибки в параметрах подключений перед сохранением');
      return;
    }
    setSaving(true);
    try {
      const trimmed = rows.map((row) => ({
        ...row,
        name: row.name.trim(),
        host: row.host.trim(),
        database: row.database.trim(),
        user: row.user.trim(),
      }));
      const saved = await databasesApi.saveAll(trimmed);
      setRows(saved);
      toast.success('Список баз данных сохранён');
    } catch {
      toast.error('Не удалось сохранить список баз данных');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="Дополнительные базы данных"
      description="Именованные подключения, доступные для выбора при настройке проекта. Основная PostgreSQL (выше) доступна всегда."
      id="databases"
    >
      {loading ? (
        <LoadingBlock label="Загрузка баз данных…" />
      ) : (
        <div className={styles.rolesWrap}>
          <Callout tone="info" title="Без пароля">
            Здесь хранятся только несекретные параметры подключения. Пароли задаются
            на стороне сервера — в браузере они не сохраняются.
          </Callout>

          {rows.length > 0 && (
            <ul className={styles.dbList}>
              {rows.map((row, index) => {
                const e = submitted ? errorsByRow.get(row.id) : undefined;
                const label = row.name.trim() || `БД ${index + 1}`;
                return (
                  <li key={row.id} className={styles.dbCard}>
                    <div className={styles.dbCardHead}>
                      <span className={styles.dbCardTitle}>
                        <Database size={16} aria-hidden="true" />
                        {label}
                      </span>
                      <Button
                        variant="dangerGhost"
                        size="sm"
                        iconOnly
                        leftIcon={<Trash2 size={16} aria-hidden="true" />}
                        onClick={() => removeRow(row.id)}
                        aria-label={`Удалить подключение «${label}»`}
                        title="Удалить подключение"
                      />
                    </div>

                    <div className={styles.dbGrid}>
                      <div className={styles.gridFull}>
                        <Input
                          label="Название"
                          value={row.name}
                          onChange={(ev) => updateRow(row.id, { name: ev.target.value })}
                          placeholder="Например, Аналитическая БД"
                          required
                          error={e?.name}
                          autoComplete="off"
                        />
                      </div>
                      <Input
                        label="Адрес сервера"
                        value={row.host}
                        onChange={(ev) => updateRow(row.id, { host: ev.target.value })}
                        placeholder="127.0.0.1"
                        required
                        error={e?.host}
                        autoComplete="off"
                        mono
                      />
                      <Input
                        label="Порт"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={65535}
                        value={String(row.port)}
                        onChange={(ev) =>
                          updateRow(row.id, { port: Number(ev.target.value) })
                        }
                        placeholder="5432"
                        required
                        error={e?.port}
                        autoComplete="off"
                        mono
                      />
                      <Input
                        label="База данных"
                        value={row.database}
                        onChange={(ev) =>
                          updateRow(row.id, { database: ev.target.value })
                        }
                        placeholder="analytics_db"
                        required
                        error={e?.database}
                        autoComplete="off"
                        mono
                      />
                      <Input
                        label="Имя пользователя"
                        value={row.user}
                        onChange={(ev) => updateRow(row.id, { user: ev.target.value })}
                        placeholder="postgres"
                        required
                        error={e?.user}
                        autoComplete="username"
                        mono
                      />
                      <div className={styles.gridFull}>
                        <Select
                          label="Режим SSL"
                          value={row.sslMode}
                          onChange={(ev) =>
                            updateRow(row.id, { sslMode: ev.target.value as PgSslMode })
                          }
                        >
                          {SSL_MODES.map((mode) => (
                            <option key={mode} value={mode}>
                              {PG_SSL_LABEL[mode]}
                            </option>
                          ))}
                        </Select>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className={styles.rolesActions}>
            <Button
              variant="secondary"
              leftIcon={<Plus size={16} aria-hidden="true" />}
              onClick={addRow}
            >
              Добавить базу данных
            </Button>

            <div className={styles.rolesActionsRight}>
              <Button
                variant="primary"
                leftIcon={<Save size={16} aria-hidden="true" />}
                loading={saving}
                disabled={saving}
                onClick={handleSave}
              >
                Сохранить
              </Button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

import { useEffect, useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Input,
  Modal,
  PasswordInput,
  Select,
  useToast,
} from '../../components/ui';
import {
  databaseConnectionsApi,
  type DbConnectionInput,
} from '../../api/databaseConnectionsApi';
import { required, validHost, validPort } from '../../lib/validation';
import {
  DBMS_LABEL,
  PG_SSL_LABEL,
  type DbConnection,
  type DbmsType,
  type PgSslMode,
} from '../../types/settings';
import styles from './DbConnectionFormModal.module.css';

interface DbConnectionFormModalProps {
  open: boolean;
  onClose: () => void;
  /** Если задано — режим редактирования; иначе создание. */
  initial?: DbConnection | null;
  /** Сохранённое подключение возвращается родителю (isNew — только что создано). */
  onSaved: (connection: DbConnection, isNew: boolean) => void;
}

const DBMS_TYPES = Object.keys(DBMS_LABEL) as DbmsType[];
const SSL_MODES = Object.keys(PG_SSL_LABEL) as PgSslMode[];

interface FormErrors {
  name?: string | null;
  host?: string | null;
  port?: string | null;
  database?: string | null;
  user?: string | null;
}

/**
 * Форма подключения к БД (создание/редактирование). PostgreSQL поддержан как тип
 * подключения, а не как отдельная системная секция. Пароль никогда не приходит с
 * сервера; при редактировании пустой пароль = «не менять секрет».
 *
 * Закрывается ТОЛЬКО явной кнопкой (крестик / «Отмена» / «Сохранить»).
 */
export function DbConnectionFormModal({
  open,
  onClose,
  initial,
  onSaved,
}: DbConnectionFormModalProps) {
  const toast = useToast();
  const isEdit = Boolean(initial);

  const [name, setName] = useState('');
  const [dbmsType, setDbmsType] = useState<DbmsType>('postgres');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('5432');
  const [database, setDatabase] = useState('');
  const [user, setUser] = useState('');
  const [sslMode, setSslMode] = useState<PgSslMode>('disable');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setDbmsType(initial?.dbmsType ?? 'postgres');
    setHost(initial?.host ?? '127.0.0.1');
    setPort(String(initial?.port ?? 5432));
    setDatabase(initial?.database ?? '');
    setUser(initial?.user ?? '');
    setSslMode(initial?.sslMode ?? 'disable');
    setPassword('');
    setErrors({});
    setSaving(false);
    setConfirmClose(false);
  }, [open, initial]);

  const isDirty =
    name !== (initial?.name ?? '') ||
    dbmsType !== (initial?.dbmsType ?? 'postgres') ||
    host !== (initial?.host ?? '127.0.0.1') ||
    port !== String(initial?.port ?? 5432) ||
    database !== (initial?.database ?? '') ||
    user !== (initial?.user ?? '') ||
    sslMode !== (initial?.sslMode ?? 'disable') ||
    password !== '';

  function requestClose() {
    if (saving) return;
    if (isDirty) setConfirmClose(true);
    else onClose();
  }

  function validateAll(): boolean {
    const next: FormErrors = {
      name: required(name, 'Название'),
      host: validHost(host),
      port: validPort(port),
      database: required(database, 'База данных'),
      user: required(user, 'Имя пользователя'),
    };
    setErrors(next);
    return !Object.values(next).some(Boolean);
  }

  async function handleSave() {
    if (!validateAll()) return;
    setSaving(true);
    try {
      const input: DbConnectionInput = {
        name: name.trim(),
        dbmsType,
        host: host.trim(),
        port: Number(port),
        database: database.trim(),
        user: user.trim(),
        sslMode,
      };
      if (password.trim() !== '') input.password = password;

      const saved = initial
        ? await databaseConnectionsApi.update(initial.id, input)
        : await databaseConnectionsApi.create(input);
      onSaved(saved, !initial);
      toast.success(
        isEdit ? `Подключение «${saved.name}» обновлено` : `Подключение «${saved.name}» создано`,
      );
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось сохранить подключение');
      setSaving(false);
    }
  }

  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        title={isEdit ? 'Изменить подключение' : 'Подключить базу данных'}
        subtitle="Параметры подключения к базе данных. Пароль хранится только на сервере."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={requestClose} disabled={saving}>
              Отмена
            </Button>
            <Button variant="primary" onClick={handleSave} loading={saving}>
              Сохранить
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <Input
            label="Название"
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (errors.name) setErrors((p) => ({ ...p, name: null }));
            }}
            error={errors.name}
            placeholder="Например, Каталог-БД"
            autoComplete="off"
          />

          <Select
            label="Тип СУБД"
            required
            value={dbmsType}
            onChange={(e) => setDbmsType(e.target.value as DbmsType)}
          >
            {DBMS_TYPES.map((t) => (
              <option key={t} value={t}>
                {DBMS_LABEL[t]}
              </option>
            ))}
          </Select>

          <div className={styles.grid}>
            <Input
              label="Адрес сервера"
              required
              mono
              value={host}
              onChange={(e) => {
                setHost(e.target.value);
                if (errors.host) setErrors((p) => ({ ...p, host: null }));
              }}
              error={errors.host}
              placeholder="127.0.0.1"
              autoComplete="off"
            />
            <Input
              label="Порт"
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              required
              mono
              value={port}
              onChange={(e) => {
                setPort(e.target.value);
                if (errors.port) setErrors((p) => ({ ...p, port: null }));
              }}
              error={errors.port}
              placeholder="5432"
              autoComplete="off"
            />
          </div>

          <Input
            label="База данных"
            required
            mono
            value={database}
            onChange={(e) => {
              setDatabase(e.target.value);
              if (errors.database) setErrors((p) => ({ ...p, database: null }));
            }}
            error={errors.database}
            placeholder="catalog"
            autoComplete="off"
          />

          <Input
            label="Имя пользователя"
            required
            mono
            value={user}
            onChange={(e) => {
              setUser(e.target.value);
              if (errors.user) setErrors((p) => ({ ...p, user: null }));
            }}
            error={errors.user}
            placeholder="app"
            autoComplete="username"
          />

          <PasswordInput
            label="Пароль"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            helper={
              isEdit
                ? initial?.hasSecret
                  ? 'Пароль сохранён на сервере. Оставьте пустым, чтобы не менять.'
                  : 'Пароль ещё не задан.'
                : 'Хранится только на сервере и не возвращается обратно.'
            }
            placeholder={isEdit && initial?.hasSecret ? '••••••••' : ''}
          />

          <Select
            label="Режим SSL"
            value={sslMode}
            onChange={(e) => setSslMode(e.target.value as PgSslMode)}
          >
            {SSL_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {PG_SSL_LABEL[mode]}
              </option>
            ))}
          </Select>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmClose}
        title="Закрыть без сохранения?"
        description="Введённые параметры подключения не будут сохранены."
        confirmLabel="Закрыть"
        cancelLabel="Продолжить"
        tone="danger"
        onConfirm={() => {
          setConfirmClose(false);
          onClose();
        }}
        onCancel={() => setConfirmClose(false)}
      />
    </>
  );
}

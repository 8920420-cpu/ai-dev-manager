import { useEffect, useRef, useState } from 'react';
import { PlugZap, Save } from 'lucide-react';
import {
  Button,
  Callout,
  Input,
  LoadingBlock,
  Section,
  Select,
  Spinner,
  useToast,
} from '../../components/ui';
import { PasswordInput } from '../../components/ui/PasswordInput';
import { settingsApi, type PgPatch } from '../../api/settingsApi';
import { required, validHost, validPort } from '../../lib/validation';
import { EMPTY_CHECK, type CheckResult } from '../../types/common';
import {
  PG_SSL_LABEL,
  type PgFormValues,
  type PgSettings,
  type PgSslMode,
} from '../../types/settings';
import styles from './settings.module.css';

const SSL_MODES = Object.keys(PG_SSL_LABEL) as PgSslMode[];

const EMPTY_FORM: PgFormValues = {
  host: '',
  port: '5432',
  database: '',
  user: '',
  adminDatabase: '',
  sslMode: 'disable',
  password: '',
};

interface FieldErrors {
  host?: string | null;
  port?: string | null;
  database?: string | null;
  user?: string | null;
}

function settingsToForm(s: PgSettings): PgFormValues {
  return {
    host: s.host,
    port: String(s.port),
    database: s.database,
    user: s.user,
    adminDatabase: s.adminDatabase,
    sslMode: s.sslMode ?? 'disable',
    password: '', // пароль никогда не приходит с сервера
  };
}

/** Собрать тело запроса. Пустой пароль = не передавать поле (не менять сохранённый). */
function toPatch(form: PgFormValues): PgPatch {
  const patch: PgPatch = {
    host: form.host.trim(),
    port: Number(form.port),
    user: form.user.trim(),
    database: form.database.trim(),
    adminDatabase: form.adminDatabase.trim(),
    sslMode: form.sslMode,
  };
  if (form.password.length > 0) {
    patch.password = form.password;
  }
  return patch;
}

function validate(form: PgFormValues): FieldErrors {
  return {
    host: validHost(form.host),
    port: validPort(form.port),
    database: required(form.database, 'База данных'),
    user: required(form.user, 'Имя пользователя'),
  };
}

function hasErrors(errors: FieldErrors): boolean {
  return Boolean(errors.host || errors.port || errors.database || errors.user);
}

/**
 * Секция настроек подключения к PostgreSQL. РЕАЛЬНЫЙ backend.
 * Пароль живёт только в React state и уходит на backend в момент действия;
 * он не пишется в localStorage и не логируется.
 */
export function PostgresSection() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<CheckResult>(EMPTY_CHECK);
  const [form, setForm] = useState<PgFormValues>(EMPTY_FORM);
  const [hasPassword, setHasPassword] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});

  const hostRef = useRef<HTMLInputElement>(null);
  const portRef = useRef<HTMLInputElement>(null);
  const databaseRef = useRef<HTMLInputElement>(null);
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    settingsApi
      .get()
      .then((s) => {
        if (!active) return;
        setForm(settingsToForm(s));
        setHasPassword(s.hasPassword);
      })
      .catch(() => {
        if (active) toast.error('Не удалось загрузить настройки PostgreSQL');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = saving || check.state === 'checking';

  function setField<K extends keyof PgFormValues>(key: K, value: PgFormValues[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    // Сбросить ошибку поля при правке.
    if (key in errors) {
      setErrors((prev) => ({ ...prev, [key]: null }));
    }
  }

  function focusFirstInvalid(e: FieldErrors) {
    if (e.host) hostRef.current?.focus();
    else if (e.port) portRef.current?.focus();
    else if (e.database) databaseRef.current?.focus();
    else if (e.user) userRef.current?.focus();
  }

  async function handleTest() {
    setCheck({ state: 'checking' });
    try {
      const result = await settingsApi.test(toPatch(form));
      const checkedAt = new Date().toISOString();
      const ok = result.ok !== false;
      setCheck({
        state: ok ? 'success' : 'error',
        message:
          result.message ??
          (ok ? 'Подключение успешно' : 'Не удалось подключиться к базе данных'),
        checkedAt,
      });
    } catch (err) {
      setCheck({
        state: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Не удалось проверить подключение',
        checkedAt: new Date().toISOString(),
      });
    }
  }

  async function handleSave() {
    const nextErrors = validate(form);
    setErrors(nextErrors);
    if (hasErrors(nextErrors)) {
      toast.error('Заполните обязательные поля корректно');
      focusFirstInvalid(nextErrors);
      return;
    }
    setSaving(true);
    try {
      const saved = await settingsApi.save(toPatch(form));
      setForm(settingsToForm(saved));
      setHasPassword(saved.hasPassword);
      setCheck(EMPTY_CHECK);
      toast.success('Настройки сохранены');
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Не удалось сохранить настройки',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="PostgreSQL"
      description="Параметры подключения оркестратора к базе данных PostgreSQL."
      id="postgres"
    >
      {loading ? (
        <LoadingBlock label="Загрузка настроек…" />
      ) : (
        <form
          className={styles.pgForm}
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
          noValidate
        >
          <div className={styles.grid}>
            <Input
              ref={hostRef}
              label="Адрес сервера"
              value={form.host}
              onChange={(e) => setField('host', e.target.value)}
              placeholder="127.0.0.1"
              required
              error={errors.host ?? undefined}
              autoComplete="off"
              mono
            />
            <Input
              ref={portRef}
              label="Порт"
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={form.port}
              onChange={(e) => setField('port', e.target.value)}
              placeholder="5432"
              required
              error={errors.port ?? undefined}
              autoComplete="off"
              mono
            />
            <Input
              ref={databaseRef}
              label="База данных"
              value={form.database}
              onChange={(e) => setField('database', e.target.value)}
              placeholder="orchestrator_db"
              required
              error={errors.database ?? undefined}
              autoComplete="off"
              mono
            />
            <Input
              ref={userRef}
              label="Имя пользователя"
              value={form.user}
              onChange={(e) => setField('user', e.target.value)}
              placeholder="postgres"
              required
              error={errors.user ?? undefined}
              autoComplete="username"
              mono
            />
            <PasswordInput
              label="Пароль"
              value={form.password}
              onChange={(e) => setField('password', e.target.value)}
              autoComplete="current-password"
              placeholder={hasPassword ? '••••••••' : 'Введите пароль'}
              helper={
                hasPassword
                  ? 'Пароль уже сохранён на сервере. Оставьте поле пустым, чтобы не менять.'
                  : undefined
              }
            />
            <Select
              label="Режим SSL"
              value={form.sslMode}
              onChange={(e) => setField('sslMode', e.target.value as PgSslMode)}
            >
              {SSL_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {PG_SSL_LABEL[mode]}
                </option>
              ))}
            </Select>
            <div className={styles.gridFull}>
              <Input
                label="Служебная БД (для CREATE DATABASE)"
                value={form.adminDatabase}
                onChange={(e) => setField('adminDatabase', e.target.value)}
                placeholder="postgres"
                optional
                helper="База, к которой оркестратор подключается, чтобы создать целевую БД. Обычно postgres."
                autoComplete="off"
                mono
              />
            </div>
          </div>

          <Callout tone="warning" title="Хранение пароля">
            Пароль не сохраняется в браузере. Он передаётся на backend только в
            момент проверки или сохранения. Для продакшена рекомендуется задавать
            учётные данные через переменные окружения или секреты на сервере.
          </Callout>

          {check.state === 'checking' && (
            <span className={styles.checking} role="status">
              <Spinner size={16} label="Проверка подключения" />
              Проверяем подключение…
            </span>
          )}
          {check.state === 'success' && (
            <Callout tone="success" title="Подключение установлено">
              {check.message ?? 'Подключение успешно'}
            </Callout>
          )}
          {check.state === 'error' && (
            <Callout tone="error" title="Ошибка подключения" live>
              {check.message ?? 'Не удалось подключиться к базе данных'}
            </Callout>
          )}

          <div className={styles.pgActions}>
            <Button
              type="button"
              variant="secondary"
              leftIcon={<PlugZap size={16} aria-hidden="true" />}
              onClick={() => void handleTest()}
              loading={check.state === 'checking'}
              disabled={busy}
            >
              Проверить подключение
            </Button>
            <Button
              type="submit"
              variant="primary"
              leftIcon={<Save size={16} aria-hidden="true" />}
              loading={saving}
              disabled={busy}
            >
              Сохранить настройки
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}

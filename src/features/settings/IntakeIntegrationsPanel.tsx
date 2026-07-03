import { useEffect, useMemo, useState } from 'react';
import { Copy, KeyRound, Plus, Power, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Input,
  LoadingBlock,
  useToast,
} from '../../components/ui';
import { intakeIntegrationsApi } from '../../api/intakeIntegrationsApi';
import type {
  IntakeIntegration,
  IntakeStatRow,
  IntakeIntegrationWithToken,
} from '../../types/intakeIntegration';
import styles from './IntakeIntegrationsPanel.module.css';

/**
 * INTAKE-INTEGRATIONS-001 — раздел «Интеграции обращений» в карточке роли Task
 * Intake Officer. Отдельно от «Движка» (движок — чем роль думает; интеграции —
 * откуда приходят обращения о проблемах из приложений). Управление реестром
 * интеграций-источников: создание, включение/выключение, перевыпуск токена,
 * удаление; статистика принятых обращений по источникам.
 *
 * Токен доступа показывается РОВНО ОДИН РАЗ (при создании/перевыпуске) — сервер
 * хранит только его хэш.
 */
export function IntakeIntegrationsPanel() {
  const toast = useToast();
  const [items, setItems] = useState<IntakeIntegration[]>([]);
  const [stats, setStats] = useState<IntakeStatRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  /** Только что выданный plaintext-токен (создание/перевыпуск) — показываем один раз. */
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<IntakeIntegration | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    Promise.all([intakeIntegrationsApi.list(ctrl.signal), intakeIntegrationsApi.stats(ctrl.signal)])
      .then(([list, st]) => {
        if (ctrl.signal.aborted) return;
        setItems(list);
        setStats(st.integrations);
      })
      .catch((err) => {
        if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(true);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, []);

  const statById = useMemo(() => {
    const m = new Map<string, IntakeStatRow>();
    for (const s of stats) m.set(s.id, s);
    return m;
  }, [stats]);

  function upsertItem(next: IntakeIntegration) {
    setItems((prev) => {
      const idx = prev.findIndex((i) => i.id === next.id);
      if (idx === -1) return [next, ...prev];
      const copy = [...prev];
      copy[idx] = next;
      return copy;
    });
  }

  async function copyToken(token: string) {
    try {
      await navigator.clipboard?.writeText(token);
      toast.success('Токен скопирован в буфер обмена');
    } catch {
      toast.info('Скопируйте токен вручную');
    }
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) {
      toast.info('Укажите название интеграции');
      return;
    }
    setCreating(true);
    try {
      const created: IntakeIntegrationWithToken = await intakeIntegrationsApi.create({ name });
      const { token, ...integration } = created;
      upsertItem(integration);
      setIssued({ name: integration.name, token });
      setNewName('');
      toast.success(`Интеграция «${integration.name}» создана`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось создать интеграцию');
    } finally {
      setCreating(false);
    }
  }

  async function toggleEnabled(item: IntakeIntegration) {
    setBusyId(item.id);
    try {
      const updated = await intakeIntegrationsApi.update(item.id, { enabled: !item.enabled });
      upsertItem(updated);
      toast.success(updated.enabled ? 'Интеграция включена' : 'Интеграция выключена');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось изменить интеграцию');
    } finally {
      setBusyId(null);
    }
  }

  async function rotate(item: IntakeIntegration) {
    setBusyId(item.id);
    try {
      const rotated: IntakeIntegrationWithToken = await intakeIntegrationsApi.rotateToken(item.id);
      const { token, ...integration } = rotated;
      upsertItem(integration);
      setIssued({ name: integration.name, token });
      toast.success('Токен перевыпущен — старый больше не действует');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось перевыпустить токен');
    } finally {
      setBusyId(null);
    }
  }

  async function doDelete() {
    const item = confirmDelete;
    if (!item) return;
    setConfirmDelete(null);
    setBusyId(item.id);
    try {
      await intakeIntegrationsApi.remove(item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      toast.success(`Интеграция «${item.name}» удалена`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось удалить интеграцию');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="intake-integrations-title">
      <div className={styles.head}>
        <h3 className={styles.title} id="intake-integrations-title">
          Интеграции обращений
        </h3>
      </div>
      <p className={styles.desc}>
        Зарегистрированные приложения-источники, из которых пользователи сообщают о
        проблемах. Обращения приходят Приёмщику в очередь (BACKLOG) без проекта —
        проект определяет сам Приёмщик. Это не «Движок» роли: движок — чем роль
        думает, интеграции — откуда приходят обращения.
      </p>
      <p className={styles.endpoint}>
        Endpoint приёма: <span className={styles.code}>POST /api/intake/report</span>, авторизация
        по токену интеграции (<span className={styles.code}>Authorization: Bearer &lt;token&gt;</span>).
      </p>

      {issued && (
        <Callout tone="warning" title={`Токен интеграции «${issued.name}»`}>
          Скопируйте токен сейчас — он показывается один раз и на сервере не хранится
          (только его хэш).
          <code className={styles.tokenValue}>{issued.token}</code>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Copy size={15} aria-hidden="true" />}
            onClick={() => copyToken(issued.token)}
          >
            Скопировать
          </Button>
        </Callout>
      )}

      <div className={styles.createRow}>
        <div className={styles.createInput}>
          <Input
            label="Название новой интеграции"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Напр. «ПС-чат»"
            maxLength={200}
          />
        </div>
        <div className={styles.createBtn}>
          <Button
            variant="secondary"
            leftIcon={<Plus size={16} aria-hidden="true" />}
            onClick={handleCreate}
            loading={creating}
            disabled={newName.trim() === ''}
          >
            Создать
          </Button>
        </div>
      </div>

      {loading ? (
        <LoadingBlock label="Загрузка интеграций обращений…" />
      ) : error ? (
        <Callout tone="error" title="Не удалось загрузить интеграции обращений" live>
          Проверьте доступность backend (<code>/api/intake-integrations</code>).
        </Callout>
      ) : items.length === 0 ? (
        <p className={styles.empty}>Пока не зарегистрировано ни одной интеграции-источника.</p>
      ) : (
        <ul className={styles.list}>
          {items.map((item) => {
            const st = statById.get(item.id);
            return (
              <li key={item.id} className={styles.item}>
                <div className={styles.itemTop}>
                  <span className={styles.itemName}>
                    <KeyRound size={15} aria-hidden="true" />
                    {item.name}
                    {item.enabled ? (
                      <Badge tone="success">Включена</Badge>
                    ) : (
                      <Badge tone="neutral">Выключена</Badge>
                    )}
                    {!item.hasToken && <Badge tone="danger">Нет токена</Badge>}
                  </span>
                  <span className={styles.itemActions}>
                    <Button
                      variant="ghost"
                      size="sm"
                      leftIcon={<Power size={15} aria-hidden="true" />}
                      onClick={() => toggleEnabled(item)}
                      loading={busyId === item.id}
                    >
                      {item.enabled ? 'Выключить' : 'Включить'}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      leftIcon={<KeyRound size={15} aria-hidden="true" />}
                      onClick={() => rotate(item)}
                      loading={busyId === item.id}
                    >
                      Перевыпустить токен
                    </Button>
                    <Button
                      variant="dangerGhost"
                      size="sm"
                      iconOnly
                      leftIcon={<Trash2 size={15} aria-hidden="true" />}
                      onClick={() => setConfirmDelete(item)}
                      aria-label={`Удалить интеграцию «${item.name}»`}
                      title="Удалить интеграцию"
                    />
                  </span>
                </div>
                <div className={styles.itemMeta}>
                  <span>
                    Принято обращений:{' '}
                    <span className={styles.stat}>{st?.total ?? 0}</span>
                    {st && st.last24h > 0 ? ` (за 24 ч: ${st.last24h})` : ''}
                  </span>
                  <span>Лимит: {item.rateLimitPerMin}/мин (польз. {item.userRateLimitPerMin}/мин)</span>
                  <span>Мин. длина: {item.minMessageLength}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Удалить интеграцию?"
        description={
          confirmDelete
            ? `Интеграция «${confirmDelete.name}» перестанет принимать обращения. Уже принятые задачи сохранятся.`
            : ''
        }
        confirmLabel="Удалить"
        cancelLabel="Отмена"
        tone="danger"
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </section>
  );
}

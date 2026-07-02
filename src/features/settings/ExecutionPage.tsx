import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Callout, Input, LoadingBlock, PageHeader, Section, Select, useToast } from '../../components/ui';
import { appSettingsApi, type AppSettings } from '../../api/appSettingsApi';
import { integrationsApi } from '../../api/integrationsApi';
import { roleConnectionsApi } from '../../api/roleConnectionsApi';
import type { Integration } from '../../types/integration';
import { ClaudeConnectionSection } from './ClaudeConnectionSection';
import { AuditSection } from './AuditSection';
import { REASONING_ROLES } from './roleEngines';
import styles from './settings.module.css';

type LoadState = 'loading' | 'error' | 'ready';

// Карта «роль → id назначенной интеграции» ('' = не назначено). Сравнение по
// рассуждающим ролям — поверхностное (пустое значение эквивалентно отсутствию).
type AssignMap = Record<string, string>;

function sameAssignments(a: AssignMap, b: AssignMap): boolean {
  for (const r of REASONING_ROLES) {
    if ((a[r.code] ?? '') !== (b[r.code] ?? '')) return false;
  }
  return true;
}

/**
 * Раздел «Настройки → Выполнение»: глобальные параметры работы фонового runner.
 * Включает «Движок по ролям» — какая ИНТЕГРАЦИЯ исполняет каждую рассуждающую
 * роль (INTEGRATION-ENGINE-UNIFY-001: движок = выбранная интеграция). Источник
 * истины тот же, что и в карточке роли — /api/role-connectors.
 */
export function ExecutionPage() {
  const toast = useToast();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [concurrency, setConcurrency] = useState('3');
  // PROGRAMMER-PRIORITY-001: программист зафиксирован на 1 выделенном агенте
  // (приоритетный слот). Значение приходит с сервера и не редактируется.
  const [programmerConcurrency, setProgrammerConcurrency] = useState('1');
  // TASK-AUTO-ACCEPT-001: «не проверять выполненные» — авто-приёмка DONE.
  const [autoAcceptDone, setAutoAcceptDone] = useState(true);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [assignments, setAssignments] = useState<AssignMap>({});
  const [savedAssignments, setSavedAssignments] = useState<AssignMap>({});
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadState('loading');
    try {
      const [s, intgs, conns] = await Promise.all([
        appSettingsApi.get(signal),
        integrationsApi.list(),
        roleConnectionsApi.list(),
      ]);
      if (signal?.aborted) return;
      setSaved(s);
      setConcurrency(String(s.maxConcurrencyPerRole));
      setProgrammerConcurrency(String(s.programmerConcurrency));
      setAutoAcceptDone(s.autoAcceptDone);
      setIntegrations(intgs);
      const map: AssignMap = {};
      for (const c of conns) if (c.integrationId) map[c.role] = c.integrationId;
      setAssignments(map);
      setSavedAssignments(map);
      setLoadState('ready');
    } catch (e) {
      if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
      setLoadState('error');
    }
  }, []);

  const setRoleIntegration = (role: string, integrationId: string) => {
    setAssignments((prev) => {
      const next = { ...prev };
      if (integrationId) next[role] = integrationId;
      else delete next[role];
      return next;
    });
  };

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // Список движков для каждой роли = включённые интеграции; плюс ныне выключенная,
  // если именно она назначена роли (чтобы не потерять текущее назначение).
  const enabledIntegrations = useMemo(
    () => integrations.filter((i) => i.isEnabled),
    [integrations],
  );
  const optionsFor = (role: string): Integration[] => {
    const assignedId = assignments[role];
    const assigned = assignedId ? integrations.find((i) => i.id === assignedId) : undefined;
    if (assigned && !assigned.isEnabled) return [...enabledIntegrations, assigned];
    return enabledIntegrations;
  };

  const parsed = Number(concurrency);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 50;
  const progParsed = Number(programmerConcurrency);
  const progValid = Number.isInteger(progParsed) && progParsed >= 1 && progParsed <= 3;
  const dirty = saved !== null
    && (parsed !== saved.maxConcurrencyPerRole
      || progParsed !== saved.programmerConcurrency
      || autoAcceptDone !== saved.autoAcceptDone
      || !sameAssignments(assignments, savedAssignments));

  const handleSave = async () => {
    if (!valid) {
      toast.error('Укажите целое число от 1 до 50');
      return;
    }
    if (!progValid) {
      toast.error('Параллельность программиста — целое число от 1 до 3');
      return;
    }
    setSaving(true);
    try {
      const next = await appSettingsApi.save({
        maxConcurrencyPerRole: parsed,
        programmerConcurrency: progParsed,
        autoAcceptDone,
      });
      // Назначения движков (интеграций) по ролям — отдельный источник истины
      // (/api/role-connectors). Шлём все рассуждающие роли (upsert по коду роли).
      const items = REASONING_ROLES.map((r) =>
        roleConnectionsApi.make(r.code, assignments[r.code] ?? ''),
      );
      await roleConnectionsApi.saveAll(items);
      setSaved(next);
      setConcurrency(String(next.maxConcurrencyPerRole));
      setProgrammerConcurrency(String(next.programmerConcurrency));
      setAutoAcceptDone(next.autoAcceptDone);
      setSavedAssignments({ ...assignments });
      toast.success('Настройки выполнения сохранены');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось сохранить настройки');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.page}>
      <PageHeader
        title="Выполнение"
        description="Глобальные параметры фонового исполнителя задач (runner). Применяются на лету, без перезапуска сервиса."
      />

      <ClaudeConnectionSection />

      <AuditSection />

      {loadState === 'loading' && <LoadingBlock label="Загрузка настроек…" />}

      {loadState === 'error' && (
        <Callout tone="error" title="Не удалось загрузить настройки">
          <Button variant="secondary" onClick={() => void load()}>
            Повторить
          </Button>
        </Callout>
      )}

      {loadState === 'ready' && (
        <>
          <Section
            title="Параллельность ролей"
            description="Сколько задач ОДНОЙ роли runner обрабатывает одновременно (в отдельных горутинах). Касается всех рассуждающих ролей: Приёмщик задач, Архитектор, Декомпозер, Ревьюер и т.д. Больше — быстрее разгребается очередь, но выше нагрузка на модель и БД."
          >
            <div className={styles.executionForm}>
              <Input
                type="number"
                min={1}
                max={50}
                step={1}
                label="Параллельных горутин на роль"
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
                disabled={saving}
                helper="Целое число от 1 до 50. По умолчанию 3."
                error={!valid ? 'Введите целое число от 1 до 50' : undefined}
              />
            </div>
          </Section>

          <Section
            title="Движок по ролям"
            description="Какая ИНТЕГРАЦИЯ исполняет каждую рассуждающую роль: API-коннектор (DeepSeek — внутренний tool-loop оркестратора) либо хостовый драйвер (Codex / Claude Code на подписке). Драйверу оркестратор отдаёт задачу, роль и готовый промпт — он лишь гоняет модель. Тот же выбор, что в карточке роли. Список — только включённые интеграции из раздела «Интеграции». Для драйверов нужен запущенный хостовый раннер."
          >
            {enabledIntegrations.length === 0 ? (
              <Callout tone="info" title="Нет доступных интеграций">
                Добавьте интеграцию в разделе «Интеграции» (DeepSeek API, Codex или
                Claude Code драйвер), чтобы назначить роли движок.
              </Callout>
            ) : (
              <div className={styles.executionForm}>
                {REASONING_ROLES.map((r) => (
                  <Select
                    key={r.code}
                    label={r.label}
                    value={assignments[r.code] ?? ''}
                    onChange={(e) => setRoleIntegration(r.code, e.target.value)}
                    disabled={saving}
                  >
                    <option value="">DeepSeek (внутренний, по умолчанию)</option>
                    {optionsFor(r.code).map((intg) => (
                      <option key={intg.id} value={intg.id}>
                        {intg.name}
                        {intg.isEnabled ? '' : ' (выключено)'}
                      </option>
                    ))}
                  </Select>
                ))}
              </div>
            )}
          </Section>

          <Section
            title="Приёмка выполненных задач"
            description="Гейт «Проверка»: когда включён, дошедшие до статуса «Выполнено» (DONE) задачи ждут ручного подтверждения в подразделе «Задачи → Проверка». Выключив проверку (по умолчанию), выполненные задачи сразу считаются принятыми и попадают в «Выполнено» — их не нужно проверять вручную."
          >
            <div className={styles.executionForm}>
              <label className={styles.toggleRow}>
                <input
                  type="checkbox"
                  className={styles.checkbox}
                  checked={autoAcceptDone}
                  onChange={(e) => setAutoAcceptDone(e.target.checked)}
                  disabled={saving}
                />
                <span className={styles.toggleText}>
                  <span className={styles.toggleTitle}>Не проверять выполненные задачи</span>
                  <span className={styles.toggleHint}>
                    {autoAcceptDone
                      ? 'Выполненные (DONE) авто-принимаются — гейт «Проверка» отключён.'
                      : 'Выполненные (DONE) ждут ручного подтверждения в подразделе «Проверка».'}
                  </span>
                </span>
              </label>
            </div>
          </Section>

          <Section
            title="Программист (CODING): приоритетная роль"
            description="Программист держит ровно 1 выделенный агент и работает без остановки, пока есть CODING-задачи (приоритетный слот). Один агент не конкурирует сам с собой за подписку Claude, а высвобождённая ёмкость уходит другим ролям (рассуждающие роли на Codex/Claude). Значение зафиксировано на 1 и не редактируется."
          >
            <div className={styles.executionForm}>
              <Input
                type="number"
                min={1}
                max={1}
                step={1}
                label="Выделенных агентов программиста"
                value={programmerConcurrency}
                disabled
                helper="Зафиксировано на 1: приоритетный слот, работает без остановки. Остальная ёмкость — другим ролям."
              />
              <Button
                variant="primary"
                onClick={() => void handleSave()}
                loading={saving}
                disabled={!valid || !progValid || !dirty}
              >
                Сохранить
              </Button>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

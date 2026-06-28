import { useCallback, useEffect, useState } from 'react';
import { Button, Callout, Input, LoadingBlock, PageHeader, Section, Select, useToast } from '../../components/ui';
import { appSettingsApi, type AppSettings, type RoleEngine } from '../../api/appSettingsApi';
import { ClaudeConnectionSection } from './ClaudeConnectionSection';
import { AuditSection } from './AuditSection';
import styles from './settings.module.css';

type LoadState = 'loading' | 'error' | 'ready';

// ROLE-ENGINE-ROUTING-001: рассуждающие роли, которым можно назначить движок, и
// варианты движков. Программист (CODING) — отдельный конвейер Claude Code, здесь
// не настраивается.
const REASONING_ROLES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'TASK_INTAKE_OFFICER', label: 'Приёмщик задач' },
  { code: 'ARCHITECT', label: 'Архитектор' },
  { code: 'DECOMPOSER', label: 'Декомпозитор' },
  { code: 'TASK_REVIEWER', label: 'Ревьюер' },
  { code: 'FAILURE_ANALYST', label: 'Аналитик провалов' },
  { code: 'DOCUMENTATION_AUDITOR', label: 'Аудитор документации' },
  { code: 'DOCUMENTATION_KEEPER', label: 'Хранитель документации' },
];

const ENGINE_OPTIONS: ReadonlyArray<{ value: RoleEngine; label: string }> = [
  { value: 'deepseek', label: 'DeepSeek (внутренний)' },
  { value: 'codex', label: 'Codex' },
  { value: 'claude_code', label: 'Claude Code' },
];

// Карта движков по ролям сравнима поверхностно: ключ есть только у не-deepseek.
function sameEngines(a: Record<string, RoleEngine>, b: Record<string, RoleEngine>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 'deepseek') !== (b[k] ?? 'deepseek')) return false;
  return true;
}

/**
 * Раздел «Настройки → Выполнение»: глобальные параметры работы фонового runner.
 * Сейчас — «Параллельных горутин на роль»: сколько задач одной роли (Приёмщик
 * задач, Архитектор, Декомпозер и т.д.) обрабатываются одновременно. Значение
 * применяется на следующем тике runner без перезапуска сервиса.
 */
export function ExecutionPage() {
  const toast = useToast();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [concurrency, setConcurrency] = useState('3');
  const [programmerConcurrency, setProgrammerConcurrency] = useState('3');
  const [roleEngines, setRoleEngines] = useState<Record<string, RoleEngine>>({});
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadState('loading');
    try {
      const s = await appSettingsApi.get(signal);
      if (signal?.aborted) return;
      setSaved(s);
      setConcurrency(String(s.maxConcurrencyPerRole));
      setProgrammerConcurrency(String(s.programmerConcurrency));
      setRoleEngines(s.roleEngines ?? {});
      setLoadState('ready');
    } catch (e) {
      if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
      setLoadState('error');
    }
  }, []);

  const setRoleEngine = (role: string, engine: RoleEngine) => {
    setRoleEngines((prev) => {
      const next = { ...prev };
      if (engine === 'deepseek') delete next[role];
      else next[role] = engine;
      return next;
    });
  };

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const parsed = Number(concurrency);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 50;
  const progParsed = Number(programmerConcurrency);
  const progValid = Number.isInteger(progParsed) && progParsed >= 1 && progParsed <= 3;
  const dirty = saved !== null
    && (parsed !== saved.maxConcurrencyPerRole
      || progParsed !== saved.programmerConcurrency
      || !sameEngines(roleEngines, saved.roleEngines ?? {}));

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
        roleEngines,
      });
      setSaved(next);
      setConcurrency(String(next.maxConcurrencyPerRole));
      setProgrammerConcurrency(String(next.programmerConcurrency));
      setRoleEngines(next.roleEngines ?? {});
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
            description="Кто исполняет каждую рассуждающую роль: DeepSeek (внутренний tool-loop оркестратора), Codex или Claude Code (хостовые драйверы на подписке). Драйверу оркестратор отдаёт задачу, роль и готовый промпт — он лишь гоняет модель. Программист (CODING) — отдельный конвейер Claude Code. Для Codex/Claude нужен запущенный хостовый раннер (codex login / claude вход на машине)."
          >
            <div className={styles.executionForm}>
              {REASONING_ROLES.map((r) => (
                <Select
                  key={r.code}
                  label={r.label}
                  value={roleEngines[r.code] ?? 'deepseek'}
                  onChange={(e) => setRoleEngine(r.code, e.target.value as RoleEngine)}
                  disabled={saving}
                >
                  {ENGINE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              ))}
            </div>
          </Section>

          <Section
            title="Параллельность программиста (CODING)"
            description="Сколько задач PROGRAMMER исполняются одновременно. Каждая идёт в отдельном git worktree СВОЕГО микросервиса: задачи одного сервиса не пересекаются (выполняются по очереди), разные сервисы — параллельно. Жёсткий потолок — 3, чтобы не перегружать машину и модель."
          >
            <div className={styles.executionForm}>
              <Input
                type="number"
                min={1}
                max={3}
                step={1}
                label="Параллельных задач программиста"
                value={programmerConcurrency}
                onChange={(e) => setProgrammerConcurrency(e.target.value)}
                disabled={saving}
                helper="Целое число от 1 до 3. По умолчанию 3."
                error={!progValid ? 'Введите целое число от 1 до 3' : undefined}
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

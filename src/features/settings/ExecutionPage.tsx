import { useCallback, useEffect, useState } from 'react';
import { Button, Callout, Input, LoadingBlock, PageHeader, Section, useToast } from '../../components/ui';
import { appSettingsApi, type AppSettings } from '../../api/appSettingsApi';
import styles from './settings.module.css';

type LoadState = 'loading' | 'error' | 'ready';

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
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadState('loading');
    try {
      const s = await appSettingsApi.get(signal);
      if (signal?.aborted) return;
      setSaved(s);
      setConcurrency(String(s.maxConcurrencyPerRole));
      setLoadState('ready');
    } catch (e) {
      if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const parsed = Number(concurrency);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 50;
  const dirty = saved !== null && parsed !== saved.maxConcurrencyPerRole;

  const handleSave = async () => {
    if (!valid) {
      toast.error('Укажите целое число от 1 до 50');
      return;
    }
    setSaving(true);
    try {
      const next = await appSettingsApi.save({ maxConcurrencyPerRole: parsed });
      setSaved(next);
      setConcurrency(String(next.maxConcurrencyPerRole));
      toast.success(`Сохранено: ${next.maxConcurrencyPerRole} параллельных горутин на роль`);
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

      {loadState === 'loading' && <LoadingBlock label="Загрузка настроек…" />}

      {loadState === 'error' && (
        <Callout tone="error" title="Не удалось загрузить настройки">
          <Button variant="secondary" onClick={() => void load()}>
            Повторить
          </Button>
        </Callout>
      )}

      {loadState === 'ready' && (
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
            <Button
              variant="primary"
              onClick={() => void handleSave()}
              loading={saving}
              disabled={!valid || !dirty}
            >
              Сохранить
            </Button>
          </div>
        </Section>
      )}
    </div>
  );
}

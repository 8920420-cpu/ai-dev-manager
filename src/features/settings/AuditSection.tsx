import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Callout, Section, useToast } from '../../components/ui';
import { auditApi, type AuditRun, type AuditStatus } from '../../api/auditApi';
import styles from './settings.module.css';

const STATUS_TONE: Record<AuditStatus, 'neutral' | 'info' | 'success' | 'danger'> = {
  PENDING: 'neutral',
  RUNNING: 'info',
  DONE: 'success',
  FAILED: 'danger',
};
const STATUS_LABEL: Record<AuditStatus, string> = {
  PENDING: 'В очереди',
  RUNNING: 'Выполняется',
  DONE: 'Готово',
  FAILED: 'Ошибка',
};

/**
 * Настройки → Выполнение → «Аудит оркестратора».
 *
 * Кнопка ставит в очередь запуск роли Principal AI Orchestrator Auditor (off-route:
 * вне цепочки задач). Сейчас аудит выполняет внешняя Claude-сессия (как стадия
 * CODING) — кнопка лишь фиксирует запрос и показывает историю. «Потом сделаем на
 * автомате»: авто-runner будет забирать PENDING-запуски сам.
 */
export function AuditSection() {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<AuditRun[]>([]);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await auditApi.list(signal);
      if (signal?.aborted) return;
      setRuns(list);
    } catch {
      /* список истории не критичен — молча игнорируем сбой загрузки */
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const handleRun = async () => {
    setRunning(true);
    try {
      const { alreadyQueued } = await auditApi.run();
      toast.success(
        alreadyQueued ? 'Аудит уже в очереди — дождитесь завершения' : 'Аудит поставлен в очередь',
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось запустить аудит');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Section
      title="Аудит оркестратора"
      description="Запуск роли «Principal AI Orchestrator Auditor» — полный технический аудит системы (токены, контекст, промпты, маршрутизация, пайплайн, масштабируемость). Выполняется вне цепочки задач, вручную. Позже запуск станет автоматическим."
    >
      <div className={styles.executionForm}>
        <Button variant="primary" onClick={() => void handleRun()} loading={running}>
          Запустить аудит
        </Button>

        {runs.length > 0 && (
          <ul className={styles.toolList} style={{ width: '100%', maxWidth: 'none' }}>
            {runs.slice(0, 5).map((r) => (
              <li key={r.id} className={styles.toolRow}>
                <span>
                  <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                  <span className={styles.toolDesc} style={{ marginLeft: 8 }}>
                    {new Date(r.requestedAt).toLocaleString('ru-RU')}
                  </span>
                </span>
                {r.status === 'FAILED' && r.errorText && (
                  <span className={styles.toolDesc}>{r.errorText}</span>
                )}
              </li>
            ))}
          </ul>
        )}

        {runs.length === 0 && (
          <Callout tone="info" title="Аудит ещё не запускался">
            Нажмите «Запустить аудит», чтобы поставить первый прогон в очередь.
          </Callout>
        )}
      </div>
    </Section>
  );
}

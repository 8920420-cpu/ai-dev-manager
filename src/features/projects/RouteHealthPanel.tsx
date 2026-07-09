import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Badge, Button, Callout } from '../../components/ui';
import type { BadgeTone } from '../../components/ui';
import { developmentSchemeApi } from '../../api/developmentSchemeApi';
import type { RouteHealthProblem, RouteHealthReport } from '../../api/developmentSchemeApi';
import styles from './RouteHealthPanel.module.css';

const SEVERITY_TONE: Record<RouteHealthProblem['severity'], BadgeTone> = {
  error: 'danger',
  warning: 'warning',
};

const SEVERITY_LABEL: Record<RouteHealthProblem['severity'], string> = {
  error: 'Ошибка',
  warning: 'Предупреждение',
};

/**
 * Панель health-check единого маршрута разработки: находит потенциальные тупики
 * маршрута (роль без исполнителя, этап без статуса, несоответствие типа коннектора
 * и т.п.) ДО того, как на них зависнет задача. Маршрут единый/глобальный — проп
 * projectId не требуется.
 */
export function RouteHealthPanel() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<RouteHealthReport | null>(null);

  const checkRoute = async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await developmentSchemeApi.getRouteHealth());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Не удалось проверить маршрут.',
      );
      setReport(null);
    } finally {
      setLoading(false);
    }
  };

  const isOk = report != null && report.summary.ok && report.problems.length === 0;

  return (
    <section className={styles.panel} aria-labelledby="route-health-title">
      <div className={styles.head}>
        <div className={styles.headText}>
          <h3 className={styles.title} id="route-health-title">
            Проверка маршрута
          </h3>
          <p className={styles.desc}>
            Находит потенциальные тупики маршрута разработки до того, как на них
            зависнет задача.
          </p>
        </div>
        <Button
          variant="secondary"
          leftIcon={<ShieldCheck size={16} aria-hidden="true" />}
          loading={loading}
          onClick={checkRoute}
        >
          Проверить маршрут
        </Button>
      </div>

      {error && (
        <Callout tone="error" live>
          {error}
        </Callout>
      )}

      {report && !error && isOk && (
        <Callout tone="success" live title="Тупиков маршрута не найдено" />
      )}

      {report && !error && !isOk && (
        <>
          <Callout
            tone={report.summary.error > 0 ? 'error' : 'warning'}
            live
            title="Найдены потенциальные тупики маршрута"
          >
            Всего проблем: {report.summary.total} · ошибок: {report.summary.error} ·
            предупреждений: {report.summary.warning}.
          </Callout>

          <ul className={styles.problems}>
            {report.problems.map((problem, index) => (
              <li
                key={`${problem.code}-${problem.stageId ?? ''}-${problem.roleCode ?? ''}-${index}`}
                className={styles.problem}
              >
                <div className={styles.problemHead}>
                  <Badge tone={SEVERITY_TONE[problem.severity]}>
                    {SEVERITY_LABEL[problem.severity]}
                  </Badge>
                  {(problem.stageName || problem.roleCode) && (
                    <span className={styles.problemTarget}>
                      {[problem.stageName, problem.roleCode].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </div>
                <p className={styles.problemMessage}>{problem.message}</p>
                {problem.recommendation && (
                  <p className={styles.problemReco}>{problem.recommendation}</p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

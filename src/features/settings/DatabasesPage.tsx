import { PageHeader } from '../../components/ui';
import { DatabasesSection } from './DatabasesSection';
import { PostgresSection } from './PostgresSection';
import styles from './settings.module.css';

/** Раздел «Настройки → Базы данных»: основная PostgreSQL + дополнительные подключения. */
export function DatabasesPage() {
  return (
    <div className={styles.page}>
      <PageHeader
        title="Базы данных"
        description="Параметры подключения к базам данных. Основная PostgreSQL хранится на сервере; дополнительные подключения можно выбрать при настройке проекта."
      />
      <PostgresSection />
      <DatabasesSection />
    </div>
  );
}

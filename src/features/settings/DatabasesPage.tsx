import { PageHeader } from '../../components/ui';
import { ConnectedDatabasesSection } from './ConnectedDatabasesSection';
import { DatabasesSection } from './DatabasesSection';
import { LegacyImportSection } from './LegacyImportSection';
import { PostgresSection } from './PostgresSection';
import styles from './settings.module.css';

/** Раздел «Настройки → Базы данных»: подключённые БД, основная PostgreSQL + дополнительные подключения. */
export function DatabasesPage() {
  return (
    <div className={styles.page}>
      <PageHeader
        title="Базы данных"
        description="Параметры подключения к базам данных. Основная PostgreSQL хранится на сервере; дополнительные подключения можно выбрать при настройке проекта."
      />
      <ConnectedDatabasesSection />
      <PostgresSection />
      <DatabasesSection />
      <LegacyImportSection />
    </div>
  );
}

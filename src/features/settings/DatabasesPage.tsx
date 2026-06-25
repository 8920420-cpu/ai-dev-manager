import { PageHeader } from '../../components/ui';
import { DatabaseConnectionsSection } from './DatabaseConnectionsSection';
import styles from './settings.module.css';

/**
 * Раздел «Настройки → Базы данных»: единый список подключений к БД.
 * Без категорий «основная»/«дополнительная» и без переноса локальных данных —
 * любая БД создаётся через кнопку «Подключить» (см. DATABASE-CONNECTIONS-001).
 */
export function DatabasesPage() {
  return (
    <div className={styles.page}>
      <PageHeader
        title="Базы данных"
        description="Подключения к базам данных, доступные для выбора в проектах. Каждое подключение создаётся кнопкой «Подключить»."
      />
      <DatabaseConnectionsSection />
    </div>
  );
}

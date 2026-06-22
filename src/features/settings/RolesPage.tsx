import { PageHeader } from '../../components/ui';
import { RoleConnectionsSection } from './RoleConnectionsSection';
import styles from './settings.module.css';

/** Раздел «Настройки → Роли»: привязка ролей к подключённым интеграциям. */
export function RolesPage() {
  return (
    <div className={styles.page}>
      <PageHeader
        title="Роли"
        description="Назначение коннекторов (интеграций) ролям пайплайна."
      />
      <RoleConnectionsSection />
    </div>
  );
}

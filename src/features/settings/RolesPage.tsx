import { PageHeader } from '../../components/ui';
import { RoleCardsSection } from './RoleCardsSection';
import { RoleConnectionsSection } from './RoleConnectionsSection';
import styles from './settings.module.css';

/** Раздел «Настройки → Роли»: карточки ролей и привязка к интеграциям. */
export function RolesPage() {
  return (
    <div className={styles.page}>
      <PageHeader
        title="Роли"
        description="Карточки ролей пайплайна (описание, промт, skills, видимость) и назначение коннекторов (интеграций)."
      />
      <RoleCardsSection />
      <RoleConnectionsSection />
    </div>
  );
}

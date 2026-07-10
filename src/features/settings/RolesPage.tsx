import { PageHeader } from '../../components/ui';
import { RoleCardsSection } from './RoleCardsSection';
import styles from './settings.module.css';

/** Раздел «Настройки → Роли»: карточки ролей (описание, промт, skills, назначение коннектора). */
export function RolesPage() {
  return (
    <div className={styles.page}>
      <PageHeader
        title="Роли"
        description="Карточки ролей пайплайна: описание, промт, skills, видимость и назначение коннектора (интеграции) — всё в одной карточке роли."
      />
      <RoleCardsSection />
    </div>
  );
}

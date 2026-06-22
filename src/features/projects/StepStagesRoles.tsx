import { useState } from 'react';
import { Plus, Wand2 } from 'lucide-react';
import { Button, Callout, ConfirmDialog } from '../../components/ui';
import type { Role, Stage } from '../../types/project';
import { StageRow } from './StageRow';
import styles from './StepStagesRoles.module.css';

interface StepStagesRolesProps {
  stages: Stage[];
  roles: Role[];
  /** Ошибки названий этапов по id этапа. */
  stageErrors: Record<string, string>;
  /** Ошибки обязательной папки Scanner по id этапа. */
  scanErrors: Record<string, string>;
  generalError?: string | null;
  onAddStage: () => void;
  onRemoveStage: (stageId: string) => void;
  onRenameStage: (stageId: string, name: string) => void;
  onReorderStage: (from: number, to: number) => void;
  onSetStageRole: (stageId: string, roleId: string | null) => void;
  onSetStageEnabled: (stageId: string, enabled: boolean) => void;
  onSetStageScanPath: (stageId: string, scanPath: string) => void;
  /** Заполнить этапы стандартным порядком и ролями по умолчанию. */
  onApplyDefaults: () => void;
}

/** Шаг 2: настройка этапов пайплайна и назначение ролей. */
export function StepStagesRoles({
  stages,
  roles,
  stageErrors,
  scanErrors,
  generalError,
  onAddStage,
  onRemoveStage,
  onRenameStage,
  onReorderStage,
  onSetStageRole,
  onSetStageEnabled,
  onSetStageScanPath,
  onApplyDefaults,
}: StepStagesRolesProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [confirmDefaults, setConfirmDefaults] = useState(false);

  const handleDrop = (target: number) => {
    if (dragIndex !== null && dragIndex !== target) {
      onReorderStage(dragIndex, target);
    }
    setDragIndex(null);
    setOverIndex(null);
  };

  return (
    <div className={styles.step}>
      {generalError && (
        <Callout tone="error" live>
          {generalError}
        </Callout>
      )}

      <section className={styles.section} aria-labelledby="stages-title">
        <div className={styles.sectionHead}>
          <div className={styles.sectionHeadRow}>
            <h3 className={styles.sectionTitle} id="stages-title">
              Этапы пайплайна
            </h3>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Wand2 size={16} aria-hidden="true" />}
              onClick={() => setConfirmDefaults(true)}
            >
              По умолчанию
            </Button>
          </div>
          <p className={styles.sectionDesc}>
            Задайте этапы и назначьте ответственную роль для каждого. Перетаскивайте за
            значок слева, чтобы изменить порядок запуска. Кнопка «По умолчанию» заполнит
            этапы стандартным порядком и ролями.
          </p>
        </div>

        <ul className={styles.stages}>
          {stages.map((stage, index) => (
            <StageRow
              key={stage.id}
              stage={stage}
              index={index}
              roles={roles}
              error={stageErrors[stage.id] ?? null}
              scanError={scanErrors[stage.id] ?? null}
              canRemove={stages.length > 1}
              dragging={dragIndex === index}
              dropTarget={overIndex === index && dragIndex !== null && dragIndex !== index}
              onRename={(name) => onRenameStage(stage.id, name)}
              onSetRole={(roleId) => onSetStageRole(stage.id, roleId)}
              onToggleEnabled={(en) => onSetStageEnabled(stage.id, en)}
              onSetScanPath={(scanPath) => onSetStageScanPath(stage.id, scanPath)}
              onRemove={() => onRemoveStage(stage.id)}
              onDragStart={() => setDragIndex(index)}
              onDragEnter={() => setOverIndex(index)}
              onDrop={() => handleDrop(index)}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
            />
          ))}
        </ul>

        <Button
          variant="ghost"
          leftIcon={<Plus size={16} aria-hidden="true" />}
          onClick={onAddStage}
          block
        >
          Добавить этап
        </Button>
      </section>

      <ConfirmDialog
        open={confirmDefaults}
        title="Заполнить этапы по умолчанию?"
        description="Текущий список этапов будет заменён стандартным набором с ролями по умолчанию. Изменения этапов (порядок, названия, папки Scanner) будут потеряны. Роли проекта сохранятся."
        confirmLabel="Заполнить"
        cancelLabel="Отмена"
        onConfirm={() => {
          onApplyDefaults();
          setConfirmDefaults(false);
        }}
        onCancel={() => setConfirmDefaults(false)}
      />
    </div>
  );
}

import { useState } from 'react';
import { Plus, Wand2 } from 'lucide-react';
import { Button, Callout, ConfirmDialog } from '../../components/ui';
import { isScannerRole } from '../../data/presets';
import { TASK_STATUSES } from '../../data/taskStatuses';
import type { StageSaveErrorItem } from '../../api/projectsApi';
import type { Role, Stage } from '../../types/project';
import { RouteHealthPanel } from './RouteHealthPanel';
import { StageRow } from './StageRow';
import styles from './StepStagesRoles.module.css';

interface StepStagesRolesProps {
  stages: Stage[];
  roles: Role[];
  /**
   * Идентификатор сохранённого проекта. Задан — показываем панель health-check
   * маршрута; для нового несохранённого проекта проп отсутствует и панель скрыта.
   */
  projectId?: string;
  /** Ошибки названий этапов по id этапа. */
  stageErrors: Record<string, string>;
  /** Ошибки обязательной папки Scanner по id этапа. */
  scanErrors: Record<string, string>;
  /** Ошибки статуса задач Scanner по id этапа. */
  statusErrors: Record<string, string>;
  /**
   * Серверные ошибки сохранения этапов (валидация / несогласованность контрактов
   * данных ролей). Показываются сводным списком над списком этапов.
   */
  saveErrors?: StageSaveErrorItem[];
  generalError?: string | null;
  /** Скрыть поле папки Scanner (редактор единой схемы — папка берётся из проекта). */
  hideScanPath?: boolean;
  onAddStage: () => void;
  onRemoveStage: (stageId: string) => void;
  onRenameStage: (stageId: string, name: string) => void;
  onReorderStage: (from: number, to: number) => void;
  onSetStageRole: (stageId: string, roleId: string | null) => void;
  onSetStageEnabled: (stageId: string, enabled: boolean) => void;
  onSetStageScanPath: (stageId: string, scanPath: string) => void;
  onSetStageStatus: (stageId: string, taskStatus: string) => void;
  /** Заполнить этапы стандартным порядком и ролями по умолчанию. */
  onApplyDefaults: () => void;
}

/** Шаг 2: настройка этапов пайплайна и назначение ролей. */
export function StepStagesRoles({
  stages,
  roles,
  projectId,
  stageErrors,
  scanErrors,
  statusErrors,
  saveErrors,
  generalError,
  hideScanPath = false,
  onAddStage,
  onRemoveStage,
  onRenameStage,
  onReorderStage,
  onSetStageRole,
  onSetStageEnabled,
  onSetStageScanPath,
  onSetStageStatus,
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

  // Статус, выбранный любым Scanner-этапом → к какому этапу он привязан.
  // Один статус не может обслуживаться двумя сканерами, поэтому занятый другим
  // этапом статус исчезает из доступных для остальных (см. statusOptionsFor).
  const scannerStatusByStage = new Map<string, string | undefined>();
  for (const stage of stages) {
    const role = roles.find((r) => r.id === stage.roleIds[0]);
    if (role && isScannerRole(role)) {
      scannerStatusByStage.set(stage.id, stage.taskStatus);
    }
  }
  const statusOptionsFor = (stageId: string): string[] => {
    // Ограничение уникальности статуса касается только Scanner-этапов: один
    // статус не может обслуживаться двумя сканерами. Не-Scanner этапы получают
    // полный список (статус этапа используется резолвером маршрута).
    if (!scannerStatusByStage.has(stageId)) return [...TASK_STATUSES];
    const taken = new Set<string>();
    for (const [id, status] of scannerStatusByStage) {
      if (id !== stageId && status) taken.add(status);
    }
    // Текущий статус этапа остаётся в списке (он не «занят другим»).
    return TASK_STATUSES.filter((s) => !taken.has(s));
  };

  // Человекочитаемая строка ошибки сервера: для несогласованности контрактов —
  // роль + поле, для валидации этапа — название этапа.
  const stageNameById = new Map(stages.map((s) => [s.id, s.name.trim()]));
  const describeSaveError = (e: StageSaveErrorItem): string => {
    if (e.roleCode || e.field) {
      const parts = [e.roleCode, e.field].filter(Boolean).join(' · ');
      return e.message ? `${parts}: ${e.message}` : parts;
    }
    const stageName = e.stageId ? stageNameById.get(e.stageId) : undefined;
    const prefix = stageName ? `Этап «${stageName}»` : 'Этап';
    return e.message ? `${prefix}: ${e.message}` : `${prefix}: ${e.code}`;
  };

  const hasFieldInconsistency = (saveErrors ?? []).some((e) => e.roleCode || e.field);

  return (
    <div className={styles.step}>
      {generalError && (
        <Callout tone="error" live>
          {generalError}
        </Callout>
      )}

      {saveErrors && saveErrors.length > 0 && (
        <Callout
          tone="error"
          live
          title={
            hasFieldInconsistency
              ? 'Контракты данных ролей несогласованы'
              : 'Ошибки сохранения этапов'
          }
        >
          <ul className={styles.saveErrorList}>
            {saveErrors.map((e, i) => (
              <li key={`${e.stageId ?? e.roleCode ?? ''}-${e.field ?? e.code}-${i}`}>
                {describeSaveError(e)}
              </li>
            ))}
          </ul>
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
              statusError={statusErrors[stage.id] ?? null}
              statusOptions={statusOptionsFor(stage.id)}
              hideScanPath={hideScanPath}
              canRemove={stages.length > 1}
              dragging={dragIndex === index}
              dropTarget={overIndex === index && dragIndex !== null && dragIndex !== index}
              onRename={(name) => onRenameStage(stage.id, name)}
              onSetRole={(roleId) => onSetStageRole(stage.id, roleId)}
              onToggleEnabled={(en) => onSetStageEnabled(stage.id, en)}
              onSetScanPath={(scanPath) => onSetStageScanPath(stage.id, scanPath)}
              onSetStatus={(taskStatus) => onSetStageStatus(stage.id, taskStatus)}
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

      {projectId && <RouteHealthPanel projectId={projectId} />}

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

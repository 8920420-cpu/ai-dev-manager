import { useState, type DragEvent } from 'react';
import {
  AlertCircle,
  ArrowDown,
  Diamond,
  GitFork,
  GitMerge,
  GripVertical,
  ListTree,
  Plus,
  Settings,
  SquarePlus,
  Wand2,
} from 'lucide-react';
import { Button, Callout, ConfirmDialog } from '../../components/ui';
import { isScannerRole } from '../../data/presets';
import { TASK_STATUSES, taskStatusLabel } from '../../data/taskStatuses';
import { cn } from '../../lib/cn';
import type { StageSaveErrorItem } from '../../api/projectsApi';
import type { Role, Stage, StageKind } from '../../types/project';

/** Метаданные типа узла блок-схемы для панели инструментов и рендера карточки. */
const KIND_META: Record<Exclude<StageKind, 'stage'>, { label: string; hint: string }> = {
  fork: { label: 'Разделить', hint: 'Параллельное ветвление: задача расщепляется на подзадачи' },
  join: { label: 'Объединить', hint: 'Барьер: ждёт завершения всех параллельных веток' },
  condition: { label: 'Условие', hint: 'Ветвление по исходу: задача идёт по одной из веток' },
};
import { StageSettingsModal } from './StageSettingsModal';
import { StageTasksModal } from './StageTasksModal';
import { TasksTreeModal } from './TasksTreeModal';
import styles from './SchemeFlowchart.module.css';

interface SchemeFlowchartProps {
  stages: Stage[];
  roles: Role[];
  /** Ошибки названий этапов по id этапа. */
  stageErrors: Record<string, string>;
  /** Ошибки обязательной папки Scanner по id этапа. */
  scanErrors: Record<string, string>;
  /** Ошибки статуса задач по id этапа. */
  statusErrors: Record<string, string>;
  /** Серверные ошибки сохранения этапов (сводный список сверху). */
  saveErrors?: StageSaveErrorItem[];
  generalError?: string | null;
  /** Скрыть поле папки Scanner (единая схема — папка берётся из проекта). */
  hideScanPath?: boolean;
  /** Число задач по статусам (этапам) для бейджа-счётчика на карточке. */
  taskCounts?: Record<string, number>;
  onAddStage: () => void;
  /** FORK-JOIN-001: добавить узел блок-схемы заданного типа (fork/join/condition/stage). */
  onAddNode?: (kind: StageKind) => void;
  onRemoveStage: (stageId: string) => void;
  onRenameStage: (stageId: string, name: string) => void;
  onReorderStage: (from: number, to: number) => void;
  onSetStageRole: (stageId: string, roleId: string | null) => void;
  onSetStageEnabled: (stageId: string, enabled: boolean) => void;
  onSetStageScanPath: (stageId: string, scanPath: string) => void;
  onSetStageStatus: (stageId: string, taskStatus: string) => void;
  onApplyDefaults: () => void;
}

/**
 * Блок-схема «Схемы разработки»: конвейер ролей в виде связанных карточек-узлов.
 * На карточке — номер этапа, роль, чекбокс включения и шестерёнка; вся подробная
 * настройка этапа открывается в модальном окне {@link StageSettingsModal}.
 */
export function SchemeFlowchart({
  stages,
  roles,
  stageErrors,
  scanErrors,
  statusErrors,
  saveErrors,
  generalError,
  hideScanPath = false,
  taskCounts = {},
  onAddStage,
  onAddNode,
  onRemoveStage,
  onRenameStage,
  onReorderStage,
  onSetStageRole,
  onSetStageEnabled,
  onSetStageScanPath,
  onSetStageStatus,
  onApplyDefaults,
}: SchemeFlowchartProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [dragEnabledIndex, setDragEnabledIndex] = useState<number | null>(null);
  const [openStageId, setOpenStageId] = useState<string | null>(null);
  const [tasksStageId, setTasksStageId] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [confirmDefaults, setConfirmDefaults] = useState(false);

  const handleDrop = (target: number) => {
    if (dragIndex !== null && dragIndex !== target) {
      onReorderStage(dragIndex, target);
    }
    setDragIndex(null);
    setOverIndex(null);
  };

  // Уникальность статуса касается только Scanner-этапов: один статус не может
  // обслуживаться двумя сканерами, поэтому занятый другим сканером статус
  // исчезает из доступных для остальных.
  const scannerStatusByStage = new Map<string, string | undefined>();
  for (const stage of stages) {
    const role = roles.find((r) => r.id === stage.roleIds[0]);
    if (role && isScannerRole(role)) {
      scannerStatusByStage.set(stage.id, stage.taskStatus);
    }
  }
  const statusOptionsFor = (stageId: string): string[] => {
    if (!scannerStatusByStage.has(stageId)) return [...TASK_STATUSES];
    const taken = new Set<string>();
    for (const [id, status] of scannerStatusByStage) {
      if (id !== stageId && status) taken.add(status);
    }
    return TASK_STATUSES.filter((s) => !taken.has(s));
  };

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

  const openStage = stages.find((s) => s.id === openStageId) ?? null;
  const openIndex = openStage ? stages.findIndex((s) => s.id === openStage.id) : -1;

  const tasksStage = stages.find((s) => s.id === tasksStageId) ?? null;
  const tasksStageIndex = tasksStage ? stages.findIndex((s) => s.id === tasksStage.id) : -1;
  const tasksStageName =
    tasksStage?.name.trim() || (tasksStage ? `Этап ${tasksStageIndex + 1}` : '');

  return (
    <div className={styles.wrap}>
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

      <div className={styles.head}>
        <div>
          <h3 className={styles.title}>Конвейер разработки</h3>
          <p className={styles.desc}>
            Задача движется по этапам сверху вниз. На карточке — номер, роль и
            переключатель этапа; шестерёнка открывает все настройки. Перетаскивайте
            карточку за <GripVertical size={13} aria-hidden="true" className={styles.inlineIcon} />,
            чтобы изменить порядок.
          </p>
        </div>
        <div className={styles.headActions}>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<ListTree size={16} aria-hidden="true" />}
            onClick={() => setTreeOpen(true)}
          >
            Все задачи
          </Button>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Wand2 size={16} aria-hidden="true" />}
            onClick={() => setConfirmDefaults(true)}
          >
            По умолчанию
          </Button>
        </div>
      </div>

      {onAddNode && (
        <div className={styles.toolbar} role="toolbar" aria-label="Инструменты блок-схемы">
          <span className={styles.toolbarLabel}>Добавить узел:</span>
          <button type="button" className={styles.tool} onClick={() => onAddNode('stage')}>
            <SquarePlus size={16} aria-hidden="true" />
            Этап
          </button>
          <button
            type="button"
            className={styles.tool}
            onClick={() => onAddNode('condition')}
            title={KIND_META.condition.hint}
          >
            <Diamond size={16} aria-hidden="true" />
            Условие
          </button>
          <button
            type="button"
            className={cn(styles.tool, styles.toolFork)}
            onClick={() => onAddNode('fork')}
            title={KIND_META.fork.hint}
          >
            <GitFork size={16} aria-hidden="true" />
            Разделить
          </button>
          <button
            type="button"
            className={cn(styles.tool, styles.toolJoin)}
            onClick={() => onAddNode('join')}
            title={KIND_META.join.hint}
          >
            <GitMerge size={16} aria-hidden="true" />
            Объединить
          </button>
        </div>
      )}

      <ol className={styles.flow}>
        <li className={styles.startNode} aria-hidden="true">
          <span className={styles.startDot} />
          Старт
        </li>
        <li className={styles.connector} aria-hidden="true">
          <ArrowDown size={16} />
        </li>

        {stages.map((stage, index) => {
          const enabled = stage.enabled !== false;
          const kind = stage.kind ?? 'stage';
          const control = kind !== 'stage';
          const role = roles.find((r) => r.id === stage.roleIds[0]);
          const scanner = !control && role ? isScannerRole(role) : false;
          const hasError = Boolean(
            stageErrors[stage.id] || scanErrors[stage.id] || statusErrors[stage.id],
          );
          const stageLabel =
            stage.name.trim() || (control ? KIND_META[kind].label : `Этап ${index + 1}`);
          // Число задач сейчас на этом этапе (по статусу этапа, по всем проектам).
          const taskCount = stage.taskStatus ? taskCounts[stage.taskStatus] ?? 0 : 0;

          return (
            <li key={stage.id} className={styles.nodeWrap}>
              <div
                className={cn(
                  styles.node,
                  control && styles.nodeControl,
                  kind === 'fork' && styles.nodeFork,
                  kind === 'join' && styles.nodeJoin,
                  kind === 'condition' && styles.nodeCondition,
                  !enabled && styles.nodeDisabled,
                  scanner && styles.nodeScanner,
                  hasError && styles.nodeError,
                  dragIndex === index && styles.nodeDragging,
                  overIndex === index &&
                    dragIndex !== null &&
                    dragIndex !== index &&
                    styles.nodeDropTarget,
                )}
                draggable={dragEnabledIndex === index}
                onDragStart={() => setDragIndex(index)}
                onDragEnter={() => setOverIndex(index)}
                onDragOver={(e: DragEvent) => e.preventDefault()}
                onDrop={(e: DragEvent) => {
                  e.preventDefault();
                  handleDrop(index);
                }}
                onDragEnd={() => {
                  setDragEnabledIndex(null);
                  setDragIndex(null);
                  setOverIndex(null);
                }}
              >
                <div className={styles.nodeHead}>
                  <button
                    type="button"
                    className={styles.grip}
                    onMouseDown={() => setDragEnabledIndex(index)}
                    onMouseUp={() => setDragEnabledIndex(null)}
                    onBlur={() => setDragEnabledIndex(null)}
                    aria-label={`Перетащите, чтобы изменить порядок этапа «${stageLabel}»`}
                    title="Перетащить для изменения порядка"
                  >
                    <GripVertical size={16} aria-hidden="true" />
                  </button>
                  <span className={cn(styles.number, control && styles.numberControl)}>
                    {index + 1}
                  </span>
                  {control && (
                    <span className={styles.kindTag}>
                      {kind === 'fork' && <GitFork size={14} aria-hidden="true" />}
                      {kind === 'join' && <GitMerge size={14} aria-hidden="true" />}
                      {kind === 'condition' && <Diamond size={14} aria-hidden="true" />}
                      {KIND_META[kind].label}
                    </span>
                  )}
                  <span className={styles.spacer} />
                  {hasError && (
                    <AlertCircle
                      size={16}
                      className={styles.errorIcon}
                      aria-label="В настройках этапа есть ошибки"
                    />
                  )}
                  <label
                    className={styles.toggle}
                    title={enabled ? 'Этап включён' : 'Этап отключён'}
                  >
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      checked={enabled}
                      onChange={(e) => onSetStageEnabled(stage.id, e.target.checked)}
                      aria-label={`Включить этап «${stageLabel}»`}
                    />
                  </label>
                  <button
                    type="button"
                    className={styles.gear}
                    onClick={() => setOpenStageId(stage.id)}
                    aria-label={`Настройки этапа «${stageLabel}»`}
                    title="Настройки этапа"
                  >
                    <Settings size={16} aria-hidden="true" />
                  </button>
                </div>

                {control ? (
                  <div className={styles.nodeMeta}>
                    <span className={styles.controlHint}>
                      {stage.name.trim() ? `${stage.name.trim()} — ` : ''}
                      {KIND_META[kind].hint}
                    </span>
                    {!enabled && <span className={styles.offChip}>Отключён</span>}
                  </div>
                ) : (
                  <>
                    <div className={styles.nodeMeta}>
                      {role ? (
                        <span
                          className={cn(styles.roleChip, scanner && styles.roleChipScanner)}
                        >
                          {role.name}
                        </span>
                      ) : (
                        <span className={styles.roleEmpty}>Роль не выбрана</span>
                      )}
                      {enabled && stage.taskStatus && (
                        <span className={styles.statusChip}>
                          {taskStatusLabel(stage.taskStatus)}
                        </span>
                      )}
                      {!enabled && <span className={styles.offChip}>Отключён</span>}
                    </div>

                    <div className={styles.nodeActions}>
                      <button
                        type="button"
                        className={styles.tasksBtn}
                        onClick={() => setTasksStageId(stage.id)}
                      >
                        <ListTree size={15} aria-hidden="true" />
                        Задачи
                        <span
                          className={cn(styles.taskCount, taskCount > 0 && styles.taskCountActive)}
                          title={`Задач на этом этапе сейчас: ${taskCount}`}
                        >
                          {taskCount}
                        </span>
                      </button>
                    </div>
                  </>
                )}
              </div>

              <div className={styles.connector} aria-hidden="true">
                <ArrowDown size={16} />
              </div>
            </li>
          );
        })}

        <li className={styles.addNodeWrap}>
          <button type="button" className={styles.addNode} onClick={onAddStage}>
            <Plus size={18} aria-hidden="true" />
            Добавить этап
          </button>
        </li>
      </ol>

      {openStage && (
        <StageSettingsModal
          open
          onClose={() => setOpenStageId(null)}
          stage={openStage}
          index={openIndex}
          roles={roles}
          statusOptions={statusOptionsFor(openStage.id)}
          nameError={stageErrors[openStage.id] ?? null}
          scanError={scanErrors[openStage.id] ?? null}
          statusError={statusErrors[openStage.id] ?? null}
          hideScanPath={hideScanPath}
          canRemove={stages.length > 1}
          onRename={(name) => onRenameStage(openStage.id, name)}
          onSetRole={(roleId) => onSetStageRole(openStage.id, roleId)}
          onToggleEnabled={(en) => onSetStageEnabled(openStage.id, en)}
          onSetScanPath={(scanPath) => onSetStageScanPath(openStage.id, scanPath)}
          onSetStatus={(taskStatus) => onSetStageStatus(openStage.id, taskStatus)}
          onRemove={() => onRemoveStage(openStage.id)}
        />
      )}

      <StageTasksModal
        open={tasksStage !== null}
        onClose={() => setTasksStageId(null)}
        roleId={tasksStage?.roleIds[0] ?? null}
        stageName={tasksStageName}
      />

      <TasksTreeModal open={treeOpen} onClose={() => setTreeOpen(false)} />

      <ConfirmDialog
        open={confirmDefaults}
        title="Заполнить этапы по умолчанию?"
        description="Текущий список этапов будет заменён стандартным набором с ролями по умолчанию. Изменения этапов (порядок, названия, папки Scanner) будут потеряны. Роли сохранятся."
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

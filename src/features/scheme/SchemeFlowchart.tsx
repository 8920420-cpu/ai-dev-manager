import { Fragment, useState, type DragEvent, type ReactNode } from 'react';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  CornerDownLeft,
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
import type { Role, SchemeEdge, Stage, StageKind } from '../../types/project';
import {
  buildSchemeLayout,
  type LayoutBranch,
  type LayoutItem,
  type PlacedNode,
} from './schemeLayout';

/** Метаданные типа узла блок-схемы для панели инструментов и рендера карточки. */
const KIND_META: Record<Exclude<StageKind, 'stage'>, { label: string; hint: string }> = {
  fork: { label: 'Разделить', hint: 'Параллельное ветвление: задача расщепляется на подзадачи' },
  join: { label: 'Объединить', hint: 'Барьер: ждёт завершения всех параллельных веток' },
  condition: { label: 'Условие', hint: 'Ветвление по исходу: задача идёт по одной из веток' },
};

// LEGACY-LINEAR-FALLBACK: «Тесты и анализ сбоя» — Pipeline Service (прогон тестов) и
// Failure Analyst (диагност падения) образуют один логический шаг. Группировка чисто
// презентационная и применяется ТОЛЬКО в linear-fallback (когда валидных рёбер нет).
// В graph-mode ветвление берётся из рёбер, а не из соседства ролей по порядку.
const TESTING_GROUP_ROLES = new Set(['PIPELINE_SERVICE', 'FAILURE_ANALYST']);
const TESTING_GROUP_LABEL = 'Тесты и анализ сбоя';
import { StageSettingsModal } from './StageSettingsModal';
import { StageTasksModal } from './StageTasksModal';
import { TasksTreeModal } from './TasksTreeModal';
import styles from './SchemeFlowchart.module.css';

interface SchemeFlowchartProps {
  stages: Stage[];
  /**
   * SCHEME-GRAPH-LAYOUT-001: рёбра графа схемы (`global_stage_edges`). Если заданы и
   * соответствуют узлам — маршрут рисуется ПО РЁБРАМ (graph-mode: ветвления, condition-
   * подписи, схождения). Иначе — linear-fallback по порядку узлов.
   */
  edges?: SchemeEdge[];
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
  /**
   * Число параллельно работающих процессов (RUNNING agent_runs) по статусам
   * (этапам) — для счётчика активных процессов рядом с кнопкой «Задачи».
   */
  runningCounts?: Record<string, number>;
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
  /** FORK-JOIN-001: задать/снять парный join у узла fork (null — авто). */
  onSetStageJoinKey?: (stageId: string, joinKey: string | null) => void;
  onApplyDefaults: () => void;
}

/**
 * Блок-схема «Разработка»: конвейер ролей в виде связанных карточек-узлов.
 * Маршрут рисуется по РЁБРАМ графа (graph-mode): линейная ось, ветвления fork/condition
 * с подписями исходов, схождение в merge, терминал «Выполнено» у реального конца и
 * группа недостижимых узлов. Без валидных рёбер — linear-fallback по порядку узлов.
 */
export function SchemeFlowchart({
  stages,
  edges,
  roles,
  stageErrors,
  scanErrors,
  statusErrors,
  saveErrors,
  generalError,
  hideScanPath = false,
  taskCounts = {},
  runningCounts = {},
  onAddStage,
  onAddNode,
  onRemoveStage,
  onRenameStage,
  onReorderStage,
  onSetStageRole,
  onSetStageEnabled,
  onSetStageScanPath,
  onSetStageStatus,
  onSetStageJoinKey,
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

  // FORK-JOIN-001: узлы join (с ключом) — варианты парного барьера для fork.
  const joinOptions = stages.flatMap((s, i) =>
    (s.kind === 'join' && s.stageKey)
      ? [{ key: s.stageKey, label: s.name.trim() || `Узел ${i + 1} (join)` }]
      : [],
  );

  // SCHEME-GRAPH-LAYOUT-001: раскладка по рёбрам графа (или linear-fallback).
  const layout = buildSchemeLayout(stages, edges ?? []);

  // Порядковые номера карточек — по ПОРЯДКУ ОБХОДА графа (а не по позиции в массиве:
  // в БД узлы могут стоять не в порядке маршрута). Для linear-fallback номер = index+1.
  const seq = new Map<string, number>();
  if (layout.mode === 'graph') {
    let n = 0;
    const number = (items: LayoutItem[]): void => {
      for (const it of items) {
        if (it.type === 'node') {
          n += 1;
          seq.set(it.node.stage.id, n);
        } else {
          n += 1;
          seq.set(it.parent.stage.id, n);
          for (const b of it.branches) number(b.items);
        }
      }
    };
    number(layout.items);
    for (const pn of layout.detached) {
      n += 1;
      seq.set(pn.stage.id, n);
    }
  }

  // Код роли этапа (для linear-fallback: группировка «Тесты и анализ сбоя»).
  const roleCodeOfStage = (stage: Stage): string =>
    roles.find((r) => r.id === stage.roleIds[0])?.code ?? '';

  const connectorEl = (key?: string): ReactNode => (
    <div key={key} className={styles.connector} aria-hidden="true">
      <ArrowDown size={16} />
    </div>
  );

  // Карточка одного узла-этапа. Переиспользуется в линейной цепочке, в колонках
  // параллельных веток и в группе недостижимых узлов. Номер берётся из seq (порядок
  // обхода графа), с откатом на index+1 (linear-fallback).
  const renderCard = (stage: Stage, index: number) => {
    const displayNo = seq.get(stage.id) ?? index + 1;
    const enabled = stage.enabled === true;
    const kind = stage.kind ?? 'stage';
    const control = kind !== 'stage';
    const role = roles.find((r) => r.id === stage.roleIds[0]);
    const scanner = !control && role ? isScannerRole(role) : false;
    const hasError = Boolean(
      stageErrors[stage.id] || scanErrors[stage.id] || statusErrors[stage.id],
    );
    const stageLabel =
      stage.name.trim() || (control ? KIND_META[kind].label : `Этап ${displayNo}`);
    // Перезапущенные задачи (статус RESTART) стоят в очереди именно к Приёмщику
    // задач — учитываем их в счётчике его этапа, иначе они «пропадают» из схемы.
    const restartHere = role?.code === 'TASK_INTAKE_OFFICER' ? taskCounts['RESTART'] ?? 0 : 0;
    const taskCount =
      (stage.taskStatus ? taskCounts[stage.taskStatus] ?? 0 : 0) + restartHere;
    // Число параллельно работающих процессов (RUNNING agent_runs) на этом этапе.
    // Перезапущенные (RESTART) процессы учитываем у Приёмщика задач — по тому же
    // правилу, что и счётчик задач выше.
    const restartRunningHere =
      role?.code === 'TASK_INTAKE_OFFICER' ? runningCounts['RESTART'] ?? 0 : 0;
    const runningCount =
      (stage.taskStatus ? runningCounts[stage.taskStatus] ?? 0 : 0) + restartRunningHere;

    return (
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
            {displayNo}
          </span>
          {control && (
            <span className={styles.kindTag}>
              {kind === 'fork' && <GitFork size={14} aria-hidden="true" />}
              {kind === 'join' && <GitMerge size={14} aria-hidden="true" />}
              {kind === 'condition' && <Diamond size={14} aria-hidden="true" />}
              {KIND_META[kind].label}
            </span>
          )}
          {!control &&
            (role ? (
              <span
                className={cn(styles.roleChip, scanner && styles.roleChipScanner)}
                title={role.name}
              >
                {role.name}
              </span>
            ) : (
              <span className={styles.roleEmpty}>Роль не выбрана</span>
            ))}
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
          // Статус, действия и маршруты — одним компактным рядом с переносом
          // (роль показана выше, в шапке карточки).
          <div className={styles.nodeMeta}>
            {enabled && stage.taskStatus && (
              <span className={styles.statusChip}>{taskStatusLabel(stage.taskStatus)}</span>
            )}
            {!enabled && <span className={styles.offChip}>Отключён</span>}

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
              <span
                className={cn(
                  styles.runningCount,
                  runningCount > 0 && styles.runningCountActive,
                )}
                title={`Параллельно работающих процессов сейчас: ${runningCount}`}
                aria-label={`Параллельно работающих процессов: ${runningCount}`}
              >
                <Activity size={13} aria-hidden="true" />
                {runningCount}
              </span>
            </div>
          </div>
        )}
      </div>
    );
  };

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

      {layout.mode === 'graph'
        ? renderGraphFlow(layout, { renderCard, connectorEl, onAddStage })
        : renderLinearFlow(stages, {
            renderCard,
            connectorEl,
            onAddStage,
            roleCodeOfStage,
          })}

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
          joinOptions={joinOptions}
          canRemove={stages.length > 1}
          onRename={(name) => onRenameStage(openStage.id, name)}
          onSetRole={(roleId) => onSetStageRole(openStage.id, roleId)}
          onToggleEnabled={(en) => onSetStageEnabled(openStage.id, en)}
          onSetScanPath={(scanPath) => onSetStageScanPath(openStage.id, scanPath)}
          onSetStatus={(taskStatus) => onSetStageStatus(openStage.id, taskStatus)}
          onSetJoinKey={
            onSetStageJoinKey
              ? (joinKey) => onSetStageJoinKey(openStage.id, joinKey)
              : undefined
          }
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

      {/* Ветвление исходов Task Reviewer (linear-fallback) вынесено в renderLinearFlow. */}
    </div>
  );

  // ======================================================================
  // GRAPH-MODE РЕНДЕР — маршрут строго по рёбрам графа.
  // ======================================================================
  function renderGraphFlow(
    lay: ReturnType<typeof buildSchemeLayout>,
    ctx: {
      renderCard: (stage: Stage, index: number) => ReactNode;
      connectorEl: (key?: string) => ReactNode;
      onAddStage: () => void;
    },
  ): ReactNode {
    // Подпись условной ветки: значение condition или «по умолчанию» для fallback-ребра.
    const branchLabel = (branch: LayoutBranch, kind: 'fork' | 'condition'): ReactNode => {
      if (kind !== 'condition') return null;
      const text = branch.condition ?? 'по умолчанию';
      return (
        <span className={styles.branchLabel} title={`Условие перехода: ${text}`}>
          {text}
        </span>
      );
    };

    // Последовательность элементов оси/колонки: карточки/ветвления + коннекторы между.
    const renderSequence = (items: LayoutItem[], keyBase: string): ReactNode[] => {
      const out: ReactNode[] = [];
      items.forEach((item, i) => {
        out.push(renderItem(item, `${keyBase}-${i}`));
        if (i < items.length - 1) out.push(ctx.connectorEl(`${keyBase}-c${i}`));
      });
      return out;
    };

    const renderColumn = (
      branch: LayoutBranch,
      kind: 'fork' | 'condition',
      hasMerge: boolean,
      key: string,
    ): ReactNode => (
      <div key={key} className={styles.branch}>
        <div className={styles.branchHead}>{branchLabel(branch, kind)}</div>
        {branch.items.length > 0 ? (
          renderSequence(branch.items, `${key}-seq`)
        ) : (
          // Пустая ветка (прямой переход к merge) — тонкая проходная связь.
          <div className={styles.branchPassthrough} aria-hidden="true" />
        )}
        {/* Хвост-заполнитель тянет вертикаль ветки до шины схождения (fan-in). */}
        {hasMerge && <div className={styles.branchTail} aria-hidden="true" />}
      </div>
    );

    const renderItem = (item: LayoutItem, key: string): ReactNode => {
      if (item.type === 'node') {
        return (
          <div key={key} className={styles.nodeWrap}>
            {ctx.renderCard(item.node.stage, item.node.index)}
          </div>
        );
      }
      const { parent, kind, branches, merge, incomplete } = item;
      const groupLabel = kind === 'condition' ? 'Ветвление по условию' : 'Параллельные ветки';
      return (
        <div key={key} className={styles.branchBlock}>
          <div className={styles.nodeWrap}>
            {ctx.renderCard(parent.stage, parent.index)}
            {incomplete && (
              <span className={styles.todoBadge}>
                <AlertTriangle size={13} aria-hidden="true" />
                TODO: у ветвления меньше двух ветвей
              </span>
            )}
          </div>
          {ctx.connectorEl(`${key}-fanout`)}
          <div
            className={cn(styles.branches, merge && styles.branchesMerge)}
            role="group"
            aria-label={groupLabel}
          >
            {branches.map((b, bi) =>
              renderColumn(b, kind, Boolean(merge), `${key}-b${bi}`),
            )}
          </div>
        </div>
      );
    };

    const lastItem = lay.items[lay.items.length - 1];
    const endsAtTerminal =
      lastItem !== undefined && lastItem.type === 'node' && lastItem.terminal;

    return (
      <div className={styles.flow}>
        <div className={styles.startNode} aria-hidden="true">
          <span className={styles.startDot} />
          Старт
        </div>
        {ctx.connectorEl('start-c')}

        {lay.items.length > 0 ? (
          <>
            {lay.items.map((item, i) => (
              <Fragment key={`g-${i}`}>
                {renderItem(item, `g-${i}`)}
                {i < lay.items.length - 1 && ctx.connectorEl(`g-c${i}`)}
              </Fragment>
            ))}
            {/* Терминал «Выполнено» — только если реальный конец маршрута (нет исходящих). */}
            {endsAtTerminal && (
              <>
                {ctx.connectorEl('finish-c')}
                <div className={styles.finishNode} aria-hidden="true">
                  <span className={styles.finishDot} />
                  Выполнено
                </div>
              </>
            )}
          </>
        ) : (
          <Callout tone="warning">Нет входа графа — проверьте рёбра схемы.</Callout>
        )}

        {lay.hasCycle && (
          <div className={styles.cycleNote} role="note">
            <AlertTriangle size={14} aria-hidden="true" />
            В графе есть цикл: маршрут показан до повторного узла.
          </div>
        )}

        {lay.detached.length > 0 && (
          <div
            className={styles.detachedGroup}
            role="group"
            aria-label="Недостижимые узлы"
          >
            <span className={styles.detachedLabel}>
              <AlertTriangle size={13} aria-hidden="true" />
              TODO: недостижимые узлы (нет пути из старта)
            </span>
            {lay.detached.map((pn) => (
              <div key={pn.stage.id} className={styles.nodeWrap}>
                {ctx.renderCard(pn.stage, pn.index)}
              </div>
            ))}
          </div>
        )}

        <div className={styles.addNodeWrap}>
          <button type="button" className={styles.addNode} onClick={ctx.onAddStage}>
            <Plus size={18} aria-hidden="true" />
            Добавить этап
          </button>
        </div>
      </div>
    );
  }

  // ======================================================================
  // LINEAR-FALLBACK РЕНДЕР — обратная совместимость, когда валидных рёбер нет.
  // Маршрут по порядку узлов; презентационные группировки (Тесты и анализ сбоя,
  // ветвление исходов Task Reviewer) допустимы ТОЛЬКО здесь и изолированы от graph-mode.
  // ======================================================================
  function renderLinearFlow(
    linStages: Stage[],
    ctx: {
      renderCard: (stage: Stage, index: number) => ReactNode;
      connectorEl: (key?: string) => ReactNode;
      onAddStage: () => void;
      roleCodeOfStage: (stage: Stage) => string;
    },
  ): ReactNode {
    const connector = ctx.connectorEl();

    // Исходы проверки Task Reviewer вынесены ЗА карточку: две стрелки-ответвления с
    // подписями. Чисто презентационно (в отсутствие рёбер), aria-разметка сохранена.
    const reviewOutcomes = (
      <div
        className={styles.reviewOutcomes}
        role="list"
        aria-label="Исходы проверки Task Reviewer"
      >
        <span className={cn(styles.reviewOutcome, styles.reviewOutcomeError)} role="listitem">
          <CornerDownLeft className={styles.reviewOutcomeIcon} size={16} aria-hidden="true" />
          <span className={styles.reviewOutcomeText}>
            <span className={styles.reviewOutcomeLabel}>Ошибка</span>
            <span className={styles.reviewOutcomeTarget}>Programmer</span>
          </span>
        </span>
        <span className={cn(styles.reviewOutcome, styles.reviewOutcomeSuccess)} role="listitem">
          <ArrowDown className={styles.reviewOutcomeIcon} size={16} aria-hidden="true" />
          <span className={styles.reviewOutcomeText}>
            <span className={styles.reviewOutcomeLabel}>Успех</span>
            <span className={styles.reviewOutcomeTarget}>Pipeline Service</span>
          </span>
        </span>
      </div>
    );

    // Единицы рендера: соседние узлы ролей из TESTING_GROUP_ROLES сворачиваются в один
    // групповой блок «Тесты и анализ сбоя».
    type RenderUnit =
      | { type: 'group'; key: string; nodes: PlacedNode[] }
      | { type: 'node'; key: string; node: PlacedNode };
    const renderUnits: RenderUnit[] = [];
    linStages.forEach((stage, index) => {
      const node: PlacedNode = { stage, index };
      const inGroup = TESTING_GROUP_ROLES.has(ctx.roleCodeOfStage(stage));
      const prev = renderUnits[renderUnits.length - 1];
      if (inGroup && prev && prev.type === 'group') {
        prev.nodes.push(node);
      } else if (inGroup) {
        renderUnits.push({ type: 'group', key: `grp-${stage.id}`, nodes: [node] });
      } else {
        renderUnits.push({ type: 'node', key: stage.id, node });
      }
    });

    // Инвариант: трейлинг-стрелка последнего юнита ведёт в «Выполнено». Нарушается,
    // когда последний юнит — карточка Task Reviewer (вместо стрелки — ветвление исходов).
    const lastUnit = renderUnits[renderUnits.length - 1];
    const needsFinishConnector =
      lastUnit?.type === 'node' &&
      ctx.roleCodeOfStage(lastUnit.node.stage) === 'TASK_REVIEWER';

    return (
      <ol className={styles.flow}>
        <li className={styles.startNode} aria-hidden="true">
          <span className={styles.startDot} />
          Старт
        </li>
        <li className={styles.connector} aria-hidden="true">
          <ArrowDown size={16} />
        </li>

        {renderUnits.map((unit) => {
          if (unit.type === 'group') {
            if (unit.nodes.length === 1) {
              const { stage, index } = unit.nodes[0]!;
              return (
                <li key={unit.key} className={styles.nodeWrap}>
                  {ctx.renderCard(stage, index)}
                  {connector}
                </li>
              );
            }
            return (
              <li key={unit.key} className={styles.nodeWrap}>
                <div className={styles.groupBlock} role="group" aria-label={TESTING_GROUP_LABEL}>
                  <span className={styles.groupLabel}>{TESTING_GROUP_LABEL}</span>
                  {unit.nodes.map((pn, ni) => (
                    <Fragment key={pn.stage.id}>
                      {ctx.renderCard(pn.stage, pn.index)}
                      {ni < unit.nodes.length - 1 && connector}
                    </Fragment>
                  ))}
                </div>
                {connector}
              </li>
            );
          }
          const { stage, index } = unit.node;
          const isReviewer = ctx.roleCodeOfStage(stage) === 'TASK_REVIEWER';
          return (
            <li key={stage.id} className={styles.nodeWrap}>
              {ctx.renderCard(stage, index)}
              {isReviewer ? reviewOutcomes : connector}
            </li>
          );
        })}

        {needsFinishConnector && (
          <li className={styles.connector} aria-hidden="true">
            <ArrowDown size={16} />
          </li>
        )}

        <li className={styles.finishNode} aria-hidden="true">
          <span className={styles.finishDot} />
          Выполнено
        </li>

        <li className={styles.addNodeWrap}>
          <button type="button" className={styles.addNode} onClick={ctx.onAddStage}>
            <Plus size={18} aria-hidden="true" />
            Добавить этап
          </button>
        </li>
      </ol>
    );
  }
}

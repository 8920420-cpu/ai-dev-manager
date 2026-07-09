import { useCallback, useEffect, useReducer, useState } from 'react';
import { Button, Callout, LoadingBlock, PageHeader, useToast } from '../../components/ui';
import {
  developmentSchemeApi,
  type DevelopmentScheme,
} from '../../api/developmentSchemeApi';
import { subscribeTaskChanges, tasksApi } from '../../api/tasksApi';
import { StageSaveError, type StageSaveErrorItem } from '../../api/projectsApi';
import { isStageEnabled, type Role, type SchemeEdge, type Stage } from '../../types/project';
import { wizardReducer, type WizardState } from '../projects/wizardState';
import { SchemeFlowchart } from './SchemeFlowchart';
import { deriveSchemeEdges } from './deriveEdges';
import styles from './scheme.module.css';

type LoadState = 'loading' | 'error' | 'ready';

/** Состояние редактора схемы строим поверх wizard-редьюсера (этапы + роли). */
function toWizardState(scheme: DevelopmentScheme): WizardState {
  return { name: '', path: '', status: 'active', roles: scheme.roles, stages: scheme.stages };
}

interface SchemeErrors {
  stages: Record<string, string>;
  statuses: Record<string, string>;
  general: string | null;
}

const EMPTY_ERRORS: SchemeErrors = { stages: {}, statuses: {}, general: null };

/**
 * Клиентская проверка единой схемы. Папку Scanner НЕ проверяем — её задаёт каждый
 * проект (papka документов). Включённый этап с ролью обязан иметь статус задач
 * (по нему резолвер маршрута ведёт задачу).
 */
function validateScheme(stages: Stage[]): SchemeErrors {
  const stageErrors: Record<string, string> = {};
  const statusErrors: Record<string, string> = {};
  for (const stage of stages) {
    if (stage.name.trim().length === 0) {
      stageErrors[stage.id] = 'Укажите название этапа';
    }
    if (isStageEnabled(stage) && stage.roleIds.length > 0) {
      if (!(stage.taskStatus ?? '').trim()) {
        statusErrors[stage.id] = 'Выберите статус задач (обязательно для включённого этапа).';
      }
    }
  }
  return {
    stages: stageErrors,
    statuses: statusErrors,
    general: stages.length === 0 ? 'Добавьте хотя бы один этап.' : null,
  };
}

/**
 * DEVELOPMENT-SCHEME-001 — единая «Схема разработки»: один конвейер ролей для всех
 * проектов. Изменения применяются ко всем проектам сразу. Scanner следит за папкой
 * документов каждого проекта, поэтому его папка здесь не задаётся.
 */
export function DevelopmentSchemePage() {
  const toast = useToast();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [state, dispatch] = useReducer(wizardReducer, {
    name: '',
    path: '',
    status: 'active',
    roles: [] as Role[],
    stages: [] as Stage[],
  });
  const [errors, setErrors] = useState<SchemeErrors>(EMPTY_ERRORS);
  // FORK-JOIN-001: рёбра сохранённой схемы — для параллельной раскладки fork/join.
  const [edges, setEdges] = useState<SchemeEdge[]>([]);
  const [saveErrors, setSaveErrors] = useState<StageSaveErrorItem[]>([]);
  const [taskCounts, setTaskCounts] = useState<Record<string, number>>({});
  // Число параллельно работающих процессов (RUNNING agent_runs) по статусам этапов.
  const [runningCounts, setRunningCounts] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [orchestratorEnabled, setOrchestratorEnabled] = useState(true);
  const [togglingOrchestrator, setTogglingOrchestrator] = useState(false);

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const [scheme, runtime] = await Promise.all([
        developmentSchemeApi.get(),
        developmentSchemeApi.getRuntime(),
      ]);
      // FORK-JOIN-001: рёбра для ОТОБРАЖЕНИЯ выводим из узлов + ролей теми же
      // правилами, что и при сохранении (deriveSchemeEdges) — единый источник рёбер.
      // Иначе уже сохранённая схема со старыми рёбрами (Documentation Auditor и
      // Keeper как параллельные ветки) рисовалась бы неверно до повторного
      // сохранения. Группировка документационной ветки Auditor → Keeper видна сразу.
      const derived = deriveSchemeEdges(scheme.stages, scheme.roles);
      dispatch({ type: 'reset', state: toWizardState({ ...scheme, stages: derived.stages }) });
      setEdges(derived.edges);
      setOrchestratorEnabled(runtime.orchestratorEnabled);
      setLoadState('ready');
    } catch {
      setLoadState('error');
    }
  }, []);

  // Счётчики задач по этапам (статусам) — обновляем при загрузке и периодически.
  const loadCounts = useCallback(async (signal?: AbortSignal) => {
    try {
      const stats = await tasksApi.stats(signal);
      if (!signal?.aborted) {
        setTaskCounts(stats.byStatus);
        setRunningCounts(stats.runningByStatus);
      }
    } catch {
      /* счётчики некритичны — молча игнорируем */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const ctrl = new AbortController();
    void loadCounts(ctrl.signal);
    const unsubscribe = subscribeTaskChanges(() => void loadCounts());
    const id = setInterval(() => void loadCounts(), 30000);
    return () => {
      ctrl.abort();
      unsubscribe();
      clearInterval(id);
    };
  }, [loadCounts]);

  const handleSave = async () => {
    const next = validateScheme(state.stages);
    setErrors(next);
    if (
      Object.keys(next.stages).length > 0 ||
      Object.keys(next.statuses).length > 0 ||
      next.general
    ) {
      return;
    }
    setSaving(true);
    setSaveErrors([]);
    try {
      // FORK-JOIN-001: рёбра выводятся из порядка узлов + маркеров fork/join
      // (joinKey проставляется на fork). Без fork/join — edges пуст (линейная схема).
      const derived = deriveSchemeEdges(state.stages, state.roles);
      const saved = await developmentSchemeApi.save(derived.stages, state.roles, derived.edges);
      dispatch({ type: 'reset', state: toWizardState(saved) });
      setEdges(saved.edges);
      toast.success('Разработка сохранена и применена ко всем проектам');
    } catch (err) {
      if (err instanceof StageSaveError) {
        setSaveErrors(err.errors);
        toast.error(
          err.code === 'stage_field_inconsistent'
            ? 'Контракты данных ролей несогласованы — исправьте поля или порядок этапов.'
            : 'Этапы не прошли проверку — исправьте отмеченные поля.',
        );
      } else {
        toast.error('Не удалось сохранить разработку');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleToggleOrchestrator = async () => {
    const next = !orchestratorEnabled;
    setTogglingOrchestrator(true);
    try {
      const runtime = await developmentSchemeApi.setOrchestratorEnabled(next);
      setOrchestratorEnabled(runtime.orchestratorEnabled);
      toast.success(
        runtime.orchestratorEnabled
          ? 'Оркестратор включён: сценарий продолжит работу'
          : 'Оркестратор выключен: сценарий полностью остановлен',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Не удалось изменить состояние оркестратора');
    } finally {
      setTogglingOrchestrator(false);
    }
  };

  return (
    <div className={styles.page}>
      <PageHeader title="Разработка" />

      {loadState === 'loading' && <LoadingBlock />}

      {loadState === 'error' && (
        <Callout tone="error" title="Не удалось загрузить схему">
          <Button variant="secondary" onClick={() => void load()}>
            Повторить
          </Button>
        </Callout>
      )}

      {loadState === 'ready' && (
        <>
          <div className={styles.orchestratorBar}>
            <div>
              <div className={styles.orchestratorTitle}>Оркестратор</div>
              <div className={styles.orchestratorText}>
                {orchestratorEnabled
                  ? 'Включён: сценарий выполняется и раннеры получают задачи.'
                  : 'Выключен: сценарий остановлен, новые задачи раннерам не выдаются.'}
              </div>
            </div>
            <Button
              variant={orchestratorEnabled ? 'dangerGhost' : 'primary'}
              onClick={handleToggleOrchestrator}
              loading={togglingOrchestrator}
              aria-pressed={orchestratorEnabled}
            >
              {orchestratorEnabled ? 'Выключить' : 'Включить'}
            </Button>
          </div>

          <SchemeFlowchart
            stages={state.stages}
            edges={edges}
            roles={state.roles}
            stageErrors={errors.stages}
            scanErrors={{}}
            statusErrors={errors.statuses}
            generalError={errors.general}
            saveErrors={saveErrors}
            hideScanPath
            taskCounts={taskCounts}
            runningCounts={runningCounts}
            onAddStage={() => dispatch({ type: 'addStage' })}
            onAddNode={(kind) => dispatch({ type: 'addNode', kind })}
            onRemoveStage={(stageId) => dispatch({ type: 'removeStage', stageId })}
            onRenameStage={(stageId, name) => dispatch({ type: 'renameStage', stageId, name })}
            onReorderStage={(from, to) => dispatch({ type: 'reorderStage', from, to })}
            onSetStageRole={(stageId, roleId) => dispatch({ type: 'setStageRole', stageId, roleId })}
            onSetStageEnabled={(stageId, enabled) =>
              dispatch({ type: 'setStageEnabled', stageId, enabled })
            }
            onSetStageScanPath={(stageId, scanPath) =>
              dispatch({ type: 'setStageScanPath', stageId, scanPath })
            }
            onSetStageStatus={(stageId, taskStatus) =>
              dispatch({ type: 'setStageStatus', stageId, taskStatus })
            }
            onSetStageJoinKey={(stageId, joinKey) =>
              dispatch({ type: 'setStageJoinKey', stageId, joinKey })
            }
            onApplyDefaults={() => dispatch({ type: 'applyDefaultStages' })}
          />

          <div className={styles.actions}>
            <Button variant="primary" onClick={handleSave} loading={saving}>
              Сохранить схему
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

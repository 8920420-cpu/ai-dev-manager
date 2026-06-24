import { useCallback, useEffect, useReducer, useState } from 'react';
import { Button, Callout, LoadingBlock, PageHeader, useToast } from '../../components/ui';
import {
  developmentSchemeApi,
  type DevelopmentScheme,
} from '../../api/developmentSchemeApi';
import { StageSaveError, type StageSaveErrorItem } from '../../api/projectsApi';
import { isStageEnabled, type Role, type Stage } from '../../types/project';
import { wizardReducer, type WizardState } from '../projects/wizardState';
import { StepStagesRoles } from '../projects/StepStagesRoles';
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
  const [saveErrors, setSaveErrors] = useState<StageSaveErrorItem[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const scheme = await developmentSchemeApi.get();
      dispatch({ type: 'reset', state: toWizardState(scheme) });
      setLoadState('ready');
    } catch {
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
      const saved = await developmentSchemeApi.save(state.stages, state.roles);
      dispatch({ type: 'reset', state: toWizardState(saved) });
      toast.success('Схема разработки сохранена и применена ко всем проектам');
    } catch (err) {
      if (err instanceof StageSaveError) {
        setSaveErrors(err.errors);
        toast.error(
          err.code === 'stage_field_inconsistent'
            ? 'Контракты данных ролей несогласованы — исправьте поля или порядок этапов.'
            : 'Этапы не прошли проверку — исправьте отмеченные поля.',
        );
      } else {
        toast.error('Не удалось сохранить схему разработки');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.page}>
      <PageHeader
        title="Схема разработки"
        description="Единый конвейер ролей для всех проектов: задайте порядок этапов, ответственные роли и статусы задач. Изменения применяются ко всем проектам сразу."
      />

      <Callout tone="info" title="Папка отслеживания задаётся в проекте">
        Scanner следит за «папкой документов» каждого проекта (поле проекта), поэтому в
        схеме папка не указывается — здесь только порядок этапов, роли и статусы.
      </Callout>

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
          <StepStagesRoles
            stages={state.stages}
            roles={state.roles}
            stageErrors={errors.stages}
            scanErrors={{}}
            statusErrors={errors.statuses}
            generalError={errors.general}
            saveErrors={saveErrors}
            hideScanPath
            onAddStage={() => dispatch({ type: 'addStage' })}
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

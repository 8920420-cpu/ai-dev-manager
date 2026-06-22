import { useEffect, useMemo, useReducer, useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Modal,
  Stepper,
  useToast,
} from '../../components/ui';
import { projectsApi } from '../../api/projectsApi';
import { required } from '../../lib/validation';
import type { CreateProjectInput, Project } from '../../types/project';
import { StepBasics } from './StepBasics';
import { StepStagesRoles } from './StepStagesRoles';
import { StepDatabase } from './StepDatabase';
import {
  buildPresetState,
  buildStateFromProject,
  isDirty,
  wizardReducer,
  type WizardState,
} from './wizardState';

interface CreateProjectModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void;
  /** Если задан — модалка работает в режиме редактирования. */
  editProject?: Project | null;
}

const STEPS = [
  { label: 'Основная информация' },
  { label: 'Этапы и роли' },
  { label: 'Подключение к БД' },
];

interface FieldErrors {
  name?: string | null;
  path?: string | null;
  stages: Record<string, string>;
  general?: string | null;
}

const EMPTY_ERRORS: FieldErrors = { stages: {} };

export function CreateProjectModal({
  open,
  onClose,
  onCreated,
  editProject,
}: CreateProjectModalProps) {
  const toast = useToast();
  const isEdit = Boolean(editProject);

  // Начальное состояние пересобирается при каждом открытии.
  const initialState = useMemo<WizardState>(
    () => (editProject ? buildStateFromProject(editProject) : buildPresetState()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editProject, open],
  );

  const [state, dispatch] = useReducer(wizardReducer, initialState);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<FieldErrors>(EMPTY_ERRORS);
  const [submitting, setSubmitting] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  // Сброс состояния при (пере)открытии модалки.
  useEffect(() => {
    if (!open) return;
    dispatch({ type: 'reset', state: initialState });
    setStep(0);
    setErrors(EMPTY_ERRORS);
    setSubmitting(false);
    setConfirmClose(false);
  }, [open, initialState]);

  const dirty = isDirty(state, initialState, step);

  const requestClose = () => {
    if (submitting) return;
    if (dirty) {
      setConfirmClose(true);
    } else {
      onClose();
    }
  };

  const reallyClose = () => {
    setConfirmClose(false);
    onClose();
  };

  const validateBasics = (): boolean => {
    const nameError = required(state.name, 'Название проекта');
    const pathError = required(state.path, 'Папка проекта');
    setErrors((prev) => ({ ...prev, name: nameError, path: pathError }));
    return !nameError && !pathError;
  };

  const validateStages = (): boolean => {
    const stageErrors: Record<string, string> = {};
    for (const stage of state.stages) {
      if (stage.name.trim().length === 0) {
        stageErrors[stage.id] = 'Укажите название этапа';
      }
    }
    let general: string | null = null;
    if (state.stages.length === 0) {
      general = 'Добавьте хотя бы один этап.';
    }
    setErrors((prev) => ({ ...prev, stages: stageErrors, general }));
    return Object.keys(stageErrors).length === 0 && !general;
  };

  const goNext = () => {
    if (step === 0) {
      if (validateBasics()) setStep(1);
    } else if (step === 1) {
      if (validateStages()) setStep(2);
    }
  };

  const goBack = () => setStep((s) => Math.max(0, s - 1));

  const handleSubmit = async () => {
    const basicsOk = validateBasics();
    const stagesOk = validateStages();
    if (!basicsOk) {
      setStep(0);
      return;
    }
    if (!stagesOk) {
      setStep(1);
      return;
    }

    setSubmitting(true);
    try {
      if (editProject) {
        const updated = await projectsApi.update(editProject.id, {
          name: state.name.trim(),
          path: state.path.trim(),
          status: state.status,
          stages: state.stages,
          roles: state.roles,
          databaseId: state.databaseId ?? undefined,
        });
        onCreated(updated);
        toast.success('Проект обновлён');
      } else {
        const input: CreateProjectInput = {
          name: state.name,
          path: state.path,
          stages: state.stages,
          roles: state.roles,
          databaseId: state.databaseId ?? undefined,
        };
        const created = await projectsApi.create(input);
        onCreated(created);
        toast.success('Проект создан');
      }
      onClose();
    } catch {
      toast.error(
        isEdit ? 'Не удалось сохранить проект' : 'Не удалось создать проект',
      );
      setSubmitting(false);
    }
  };

  const isLastStep = step === STEPS.length - 1;
  const footer = (
    <>
      {step === 0 ? (
        <Button variant="ghost" onClick={requestClose} disabled={submitting}>
          Отмена
        </Button>
      ) : (
        <Button variant="secondary" onClick={goBack} disabled={submitting}>
          Назад
        </Button>
      )}
      {isLastStep ? (
        <Button variant="primary" onClick={handleSubmit} loading={submitting}>
          {isEdit ? 'Сохранить' : 'Создать проект'}
        </Button>
      ) : (
        <Button variant="primary" onClick={goNext}>
          Далее
        </Button>
      )}
    </>
  );

  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        title={isEdit ? 'Редактирование проекта' : 'Создание проекта'}
        subtitle={
          isEdit
            ? 'Измените параметры подключённого проекта.'
            : 'Подключите локальную папку и настройте пайплайн.'
        }
        size="lg"
        dismissOnBackdrop={!dirty}
        footer={footer}
        footerStart={<Stepper steps={STEPS} current={step} />}
      >
        {step === 0 && (
          <StepBasics
            name={state.name}
            path={state.path}
            status={state.status}
            showStatus={isEdit}
            nameError={errors.name}
            pathError={errors.path}
            onNameChange={(value) => dispatch({ type: 'setName', value })}
            onPathChange={(value) => dispatch({ type: 'setPath', value })}
            onStatusChange={(value) => dispatch({ type: 'setStatus', value })}
          />
        )}
        {step === 1 && (
          <StepStagesRoles
            stages={state.stages}
            roles={state.roles}
            stageErrors={errors.stages}
            generalError={errors.general}
            onAddStage={() => dispatch({ type: 'addStage' })}
            onRemoveStage={(stageId) => dispatch({ type: 'removeStage', stageId })}
            onRenameStage={(stageId, name) =>
              dispatch({ type: 'renameStage', stageId, name })
            }
            onReorderStage={(from, to) =>
              dispatch({ type: 'reorderStage', from, to })
            }
            onSetStageRole={(stageId, roleId) =>
              dispatch({ type: 'setStageRole', stageId, roleId })
            }
            onSetStageScanPath={(stageId, scanPath) =>
              dispatch({ type: 'setStageScanPath', stageId, scanPath })
            }
          />
        )}
        {step === 2 && (
          <StepDatabase
            databaseId={state.databaseId}
            onChange={(databaseId) => dispatch({ type: 'setDatabase', databaseId })}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={confirmClose}
        title="Закрыть без сохранения?"
        description="Введённые данные будут потеряны."
        confirmLabel="Закрыть"
        cancelLabel="Продолжить редактирование"
        tone="danger"
        onConfirm={reallyClose}
        onCancel={() => setConfirmClose(false)}
      />
    </>
  );
}

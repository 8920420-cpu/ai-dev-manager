import { useEffect, useMemo, useState } from 'react';
import { Button, ConfirmDialog, Modal, useToast } from '../../components/ui';
import { projectsApi, ProjectConflictError } from '../../api/projectsApi';
import { required } from '../../lib/validation';
import type { CreateProjectInput, Project, ProjectStatus } from '../../types/project';
import { StepBasics } from './StepBasics';

interface CreateProjectModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void;
  /** Если задан — модалка работает в режиме редактирования. */
  editProject?: Project | null;
}

interface FormState {
  name: string;
  path: string;
  docsPath: string;
  tasksPath: string;
  status: ProjectStatus;
}

function initialState(editProject?: Project | null): FormState {
  return {
    name: editProject?.name ?? '',
    path: editProject?.path ?? '',
    docsPath: editProject?.docsPath ?? '',
    tasksPath: editProject?.tasksPath ?? '',
    status: editProject?.status ?? 'active',
  };
}

/** Имена подпапок 2-го уровня по умолчанию (внутри папки проекта). */
const DEFAULT_DOCS_SUBDIR = 'docs';
const DEFAULT_TASKS_SUBDIR = 'tasks';

/**
 * Путь подпапки 2-го уровня относительно папки проекта. Разделитель берётся из
 * самого пути проекта (\ для Windows, иначе /). Пустая папка проекта → ''.
 */
function joinUnderProject(projectPath: string, subdir: string): string {
  const base = projectPath.trim().replace(/[\\/]+$/, '');
  if (!base) return '';
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base}${sep}${subdir}`;
}

/**
 * Создание / редактирование проекта. Этапы пайплайна больше НЕ задаются в проекте
 * — они общие (раздел «Схема разработки»). Здесь — основные параметры проекта:
 * название, папка проекта, подпапки документов и задач (за папкой задач следит
 * Scanner) и статус. Пути подпапок по умолчанию подставляются относительно папки
 * проекта.
 */
export function CreateProjectModal({
  open,
  onClose,
  onCreated,
  editProject,
}: CreateProjectModalProps) {
  const toast = useToast();
  const isEdit = Boolean(editProject);

  const initial = useMemo(
    () => initialState(editProject),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editProject, open],
  );

  const [form, setForm] = useState<FormState>(initial);
  const [nameError, setNameError] = useState<string | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(initial);
    setNameError(null);
    setPathError(null);
    setSubmitting(false);
    setConfirmClose(false);
  }, [open, initial]);

  const dirty =
    form.name !== initial.name ||
    form.path !== initial.path ||
    form.docsPath !== initial.docsPath ||
    form.tasksPath !== initial.tasksPath ||
    form.status !== initial.status;

  // Смена папки проекта: пути 2-го уровня (документы/задачи) по умолчанию
  // указываются относительно неё. Пока пользователь не задал их вручную (поле
  // пусто или ещё равно прежнему авто-значению) — переподставляем относительно
  // новой папки проекта; ручной ввод не затираем.
  const handlePathChange = (value: string) => {
    setForm((f) => {
      const next: FormState = { ...f, path: value };
      const prevDocsDefault = joinUnderProject(f.path, DEFAULT_DOCS_SUBDIR);
      const prevTasksDefault = joinUnderProject(f.path, DEFAULT_TASKS_SUBDIR);
      if (!f.docsPath || f.docsPath === prevDocsDefault) {
        next.docsPath = joinUnderProject(value, DEFAULT_DOCS_SUBDIR);
      }
      if (!f.tasksPath || f.tasksPath === prevTasksDefault) {
        next.tasksPath = joinUnderProject(value, DEFAULT_TASKS_SUBDIR);
      }
      return next;
    });
  };

  const requestClose = () => {
    if (submitting) return;
    if (dirty) setConfirmClose(true);
    else onClose();
  };

  const reallyClose = () => {
    setConfirmClose(false);
    onClose();
  };

  const validate = (): boolean => {
    const ne = required(form.name, 'Название проекта');
    const pe = required(form.path, 'Папка проекта');
    setNameError(ne);
    setPathError(pe);
    return !ne && !pe;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setSubmitting(true);
    try {
      if (editProject) {
        let token = editProject.updatedAt;
        try {
          token = (await projectsApi.get(editProject.id)).updatedAt;
        } catch {
          // GET не удался — отправим с прежним токеном.
        }
        const updated = await projectsApi.update(editProject.id, {
          name: form.name.trim(),
          path: form.path.trim(),
          docsPath: form.docsPath.trim(),
          tasksPath: form.tasksPath.trim(),
          status: form.status,
          updatedAt: token,
        });
        onCreated(updated);
        toast.success('Проект обновлён');
      } else {
        const input: CreateProjectInput = {
          name: form.name,
          path: form.path,
          docsPath: form.docsPath,
          tasksPath: form.tasksPath,
        };
        const created = await projectsApi.create(input);
        onCreated(created);
        toast.success('Проект создан');
      }
      onClose();
    } catch (err) {
      if (err instanceof ProjectConflictError) {
        toast.error(err.message);
      } else {
        toast.error(isEdit ? 'Не удалось сохранить проект' : 'Не удалось создать проект');
      }
      setSubmitting(false);
    }
  };

  const footer = (
    <>
      <Button variant="ghost" onClick={requestClose} disabled={submitting}>
        Отмена
      </Button>
      <Button variant="primary" onClick={handleSubmit} loading={submitting}>
        {isEdit ? 'Сохранить' : 'Создать проект'}
      </Button>
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
            : 'Подключите локальную папку проекта.'
        }
        size="lg"
        footer={footer}
      >
        <StepBasics
          name={form.name}
          path={form.path}
          docsPath={form.docsPath}
          tasksPath={form.tasksPath}
          status={form.status}
          showStatus={isEdit}
          nameError={nameError}
          pathError={pathError}
          onNameChange={(value) => setForm((f) => ({ ...f, name: value }))}
          onPathChange={handlePathChange}
          onDocsPathChange={(value) => setForm((f) => ({ ...f, docsPath: value }))}
          onTasksPathChange={(value) => setForm((f) => ({ ...f, tasksPath: value }))}
          onStatusChange={(value) => setForm((f) => ({ ...f, status: value }))}
        />
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

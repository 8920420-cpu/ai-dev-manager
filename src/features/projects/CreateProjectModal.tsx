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
  status: ProjectStatus;
}

function initialState(editProject?: Project | null): FormState {
  return {
    name: editProject?.name ?? '',
    path: editProject?.path ?? '',
    docsPath: editProject?.docsPath ?? '',
    status: editProject?.status ?? 'active',
  };
}

/**
 * Создание / редактирование проекта. Этапы пайплайна больше НЕ задаются в проекте
 * — они общие (раздел «Схема разработки»). Здесь — основные параметры проекта:
 * название, папка проекта, папка документов (за ней следит Scanner) и статус.
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
    form.status !== initial.status;

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
          status={form.status}
          showStatus={isEdit}
          nameError={nameError}
          pathError={pathError}
          onNameChange={(value) => setForm((f) => ({ ...f, name: value }))}
          onPathChange={(value) => setForm((f) => ({ ...f, path: value }))}
          onDocsPathChange={(value) => setForm((f) => ({ ...f, docsPath: value }))}
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

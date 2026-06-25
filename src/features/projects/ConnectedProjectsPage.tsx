import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderGit2, Plus } from 'lucide-react';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  LoadingBlock,
  PageHeader,
  useToast,
} from '../../components/ui';
import { projectsApi } from '../../api/projectsApi';
import {
  OPEN_PROJECT_MONITOR_EVENT,
  type OpenProjectMonitorDetail,
} from '../../app/projectMonitorBus';
import type { Project } from '../../types/project';
import { ProjectCard } from './ProjectCard';
import { CreateProjectModal } from './CreateProjectModal';
import { ProjectMonitor } from './ProjectMonitor';
import { ProjectPauseBanner } from './ProjectPauseBanner';
import styles from './ConnectedProjectsPage.module.css';

type LoadState = 'loading' | 'error' | 'ready';

export function ConnectedProjectsPage() {
  const toast = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');

  const [modalOpen, setModalOpen] = useState(false);
  const [editProject, setEditProject] = useState<Project | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Открытый монитор задач конкретного проекта (экран поверх списка).
  const [monitorProject, setMonitorProject] = useState<Project | null>(null);
  // Запрос «открыть монитор», пришедший до загрузки списка проектов.
  const pendingMonitorId = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const list = await projectsApi.list();
      setProjects(list);
      setLoadState('ready');
      // Применить отложенный запрос открытия монитора из сайдбара.
      if (pendingMonitorId.current) {
        const target = list.find((p) => p.id === pendingMonitorId.current);
        pendingMonitorId.current = null;
        if (target) setMonitorProject(target);
      }
    } catch {
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Открытие монитора по клику на проект в сайдбаре.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<OpenProjectMonitorDetail>).detail?.projectId;
      if (!id) return;
      const target = projects.find((p) => p.id === id);
      if (target) setMonitorProject(target);
      else pendingMonitorId.current = id; // список ещё грузится — откроем после load
    };
    window.addEventListener(OPEN_PROJECT_MONITOR_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PROJECT_MONITOR_EVENT, onOpen);
  }, [projects]);

  const openCreate = () => {
    setEditProject(null);
    setModalOpen(true);
  };

  const openEdit = (project: Project) => {
    setEditProject(project);
    setModalOpen(true);
  };

  const handleSaved = (saved: Project) => {
    setProjects((prev) => {
      const exists = prev.some((p) => p.id === saved.id);
      const next = exists
        ? prev.map((p) => (p.id === saved.id ? saved : p))
        : [saved, ...prev];
      return [...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
    // Если редактировали проект с открытым монитором — обновим его данные.
    setMonitorProject((cur) => (cur && cur.id === saved.id ? saved : cur));
  };

  const handleOpenProject = (project: Project) => {
    setMonitorProject(project);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await projectsApi.remove(deleteTarget.id);
      setProjects((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      toast.success('Проект удалён');
      setDeleteTarget(null);
    } catch {
      toast.error('Не удалось удалить проект');
    } finally {
      setDeleting(false);
    }
  };

  // Экран монитора задач выбранного проекта.
  if (monitorProject) {
    return (
      <div className={styles.page}>
        <ProjectPauseBanner project={monitorProject} onResumed={handleSaved} />
        <ProjectMonitor
          project={monitorProject}
          onBack={() => setMonitorProject(null)}
          onEdit={openEdit}
        />
        <CreateProjectModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onCreated={handleSaved}
          editProject={editProject}
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="Подключённые проекты"
        description="Локальные проекты, подключённые к AI Dev Manager: пайплайн этапов и ответственные роли."
        actions={
          <Button
            variant="primary"
            leftIcon={<Plus size={18} aria-hidden="true" />}
            onClick={openCreate}
          >
            Создать проект
          </Button>
        }
      />

      {loadState === 'loading' && <LoadingBlock label="Загрузка проектов…" />}

      {loadState === 'error' && (
        <EmptyState
          tone="error"
          title="Не удалось загрузить проекты"
          description="Произошла ошибка при получении списка проектов. Попробуйте ещё раз."
          action={
            <Button variant="secondary" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      )}

      {loadState === 'ready' && projects.length === 0 && (
        <EmptyState
          icon={<FolderGit2 size={40} aria-hidden="true" />}
          title="Пока нет подключённых проектов"
          description="Подключите локальную папку проекта, чтобы настроить этапы пайплайна и назначить ответственные роли."
          action={
            <Button
              variant="primary"
              leftIcon={<Plus size={18} aria-hidden="true" />}
              onClick={openCreate}
            >
              Создать проект
            </Button>
          }
        />
      )}

      {loadState === 'ready' && projects.length > 0 && (
        <div className={styles.grid}>
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onOpen={handleOpenProject}
              onEdit={openEdit}
              onDelete={setDeleteTarget}
              onUpdated={handleSaved}
            />
          ))}
        </div>
      )}

      <CreateProjectModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={handleSaved}
        editProject={editProject}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Удалить проект?"
        description={
          deleteTarget
            ? `Проект «${deleteTarget.name}» будет удалён из списка. Папка на диске не затрагивается.`
            : undefined
        }
        confirmLabel="Удалить"
        cancelLabel="Отмена"
        tone="danger"
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

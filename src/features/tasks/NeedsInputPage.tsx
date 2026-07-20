import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderGit2, MessageCircleQuestion, RefreshCw, Send } from 'lucide-react';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  LoadingBlock,
  Modal,
  PageHeader,
  Select,
  Textarea,
  useToast,
} from '../../components/ui';
import { subscribeTaskChanges, tasksApi, type NeedsInputTask } from '../../api/tasksApi';
import { projectsApi } from '../../api/projectsApi';
import type { Project } from '../../types/project';
import { taskStatusLabel, taskStatusTone } from '../../data/taskStatuses';
import { taskPriorityLabel, taskPriorityTone } from '../../data/taskPriorities';
import { composeAnswer, selectNeedsInputRows, type NeedsInputRow } from './needsInputRows';
import styles from './NeedsInputPage.module.css';

type LoadState = 'loading' | 'error' | 'ready';

/** Статус задач этой доски — все строки здесь ждут ответа человека. */
const NEEDS_INPUT_STATUS = 'NEEDS_INPUT';

/**
 * TASK-NEEDS-INPUT-001 — подраздел «Задачи · Нужна информация».
 *
 * Очередь задач, которые агент-исполнитель остановил на неоднозначности
 * (status=NEEDS_INPUT) и по каждой задал человеку один конкретный вопрос.
 * Источник — GET /api/tasks/needs-input-board. Клик по строке открывает модалку
 * с вопросом: человек выбирает вариант и/или пишет пояснение, после ответа
 * задача возвращается в работу и исчезает из очереди.
 */
export function NeedsInputPage() {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [board, setBoard] = useState<NeedsInputTask[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<NeedsInputRow | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadState('loading');
    try {
      const [boardData, projectList] = await Promise.all([
        tasksApi.needsInputBoard(signal),
        projectsApi.list(signal),
      ]);
      if (signal?.aborted) return;
      setBoard(boardData.tasks);
      setProjects(projectList);
      setLoadState('ready');
    } catch (e) {
      if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // Вопрос может прилететь в любой момент работы конвейера — держим очередь
  // свежей без перезагрузки страницы.
  useEffect(() => {
    return subscribeTaskChanges(() => {
      tasksApi
        .needsInputBoard()
        .then((data) => setBoard(data.tasks))
        .catch(() => {});
    });
  }, []);

  const rows = useMemo(() => selectNeedsInputRows(board, projects), [board, projects]);

  const handleAnswered = useCallback(async () => {
    setSelected(null);
    await load();
  }, [load]);

  return (
    <div className={styles.page}>
      <PageHeader
        title="Нужна информация"
        description="Задачи, которые исполнитель остановил на неоднозначности: по каждой он задал один вопрос и ждёт ответа. Откройте задачу, выберите вариант или опишите решение — задача вернётся в работу."
        actions={
          <Button
            variant="secondary"
            leftIcon={<RefreshCw size={16} aria-hidden="true" />}
            onClick={() => void load()}
            disabled={loadState === 'loading'}
          >
            Обновить
          </Button>
        }
      />

      {loadState === 'loading' && <LoadingBlock label="Загрузка вопросов…" />}

      {loadState === 'error' && (
        <Callout tone="error" title="Не удалось загрузить задачи">
          <Button variant="secondary" onClick={() => void load()}>
            Повторить
          </Button>
        </Callout>
      )}

      {loadState === 'ready' && rows.length === 0 && (
        <EmptyState
          icon={<MessageCircleQuestion size={28} aria-hidden="true" />}
          title="Вопросов нет"
          description="Никто из исполнителей сейчас не ждёт ответа. Когда агент упрётся в неоднозначность, задача с его вопросом появится здесь."
        />
      )}

      {loadState === 'ready' && rows.length > 0 && (
        <>
          <p className={styles.summary}>Ждут ответа: {rows.length}</p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Проект</th>
                  <th>Сервис</th>
                  <th>Название</th>
                  <th>Вопрос</th>
                  <th>Приоритет</th>
                  <th>Когда спросили</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className={styles.row}
                    tabIndex={0}
                    role="button"
                    onClick={() => setSelected(row)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelected(row);
                      }
                    }}
                  >
                    <td>
                      <span className={styles.projectCell}>
                        <FolderGit2 size={15} aria-hidden="true" className={styles.projectIcon} />
                        {row.projectName}
                      </span>
                    </td>
                    <td className={styles.muted}>{row.serviceCode}</td>
                    <td className={styles.titleCell} title={row.title}>
                      {row.title}
                    </td>
                    <td className={styles.questionCell} title={row.question}>
                      {row.questionPreview}
                    </td>
                    <td>
                      <Badge tone={taskPriorityTone(row.priority)}>
                        {taskPriorityLabel(row.priority)}
                      </Badge>
                    </td>
                    <td className={styles.muted}>{formatDate(row.askedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <AnswerQuestionModal
        row={selected}
        onCancel={() => setSelected(null)}
        onDone={handleAnswered}
      />
    </div>
  );
}

/** Дата ISO → локальная короткая строка (или прочерк). */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU');
}

/** Значение Select, означающее «отвечу своими словами» (готовый вариант не выбран). */
const CUSTOM_ANSWER = '';

/**
 * Модалка ответа на вопрос агента. Вариант и пояснение независимы: можно выбрать
 * готовый вариант, можно написать свой текст, можно и то и другое — тогда они
 * уходят одной строкой (см. composeAnswer).
 */
function AnswerQuestionModal({
  row,
  onCancel,
  onDone,
}: {
  row: NeedsInputRow | null;
  onCancel: () => void;
  onDone: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [option, setOption] = useState(CUSTOM_ANSWER);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  // Сброс формы при открытии на другой задаче: чужой ответ не должен утечь
  // в следующий вопрос.
  useEffect(() => {
    setOption(CUSTOM_ANSWER);
    setNote('');
  }, [row]);

  const options = row?.task.question.options ?? [];
  const answer = composeAnswer(option, note);

  const handleSubmit = async () => {
    if (!row || !answer) return;
    setSaving(true);
    try {
      await tasksApi.answerQuestion(row.id, {
        questionId: row.task.question.id,
        answer,
      });
      toast.success('Ответ отправлен — задача вернулась в работу');
      await onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось отправить ответ');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={row !== null}
      onClose={() => !saving && onCancel()}
      title="Вопрос исполнителя"
      subtitle={row?.title}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Отмена
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSubmit()}
            loading={saving}
            disabled={!answer}
            leftIcon={<Send size={16} aria-hidden="true" />}
          >
            Ответить
          </Button>
        </>
      }
    >
      <div className={styles.answerForm}>
        <section className={styles.block}>
          <div className={styles.meta}>
            <Badge tone={taskStatusTone(NEEDS_INPUT_STATUS)}>
              {taskStatusLabel(NEEDS_INPUT_STATUS)}
            </Badge>
            {row && <span>{row.projectName}</span>}
            {row?.task.question.roleCode && <span>Спросил: {row.task.question.roleCode}</span>}
            {row && <span>{formatDate(row.askedAt)}</span>}
          </div>
          <p className={styles.question}>{row?.question}</p>
        </section>

        {row?.task.question.context && (
          <section className={styles.block}>
            <h3 className={styles.blockTitle}>Контекст</h3>
            <p className={styles.context}>{row.task.question.context}</p>
          </section>
        )}

        {options.length > 0 && (
          <Select
            label="Вариант ответа"
            value={option}
            onChange={(e) => setOption(e.target.value)}
            disabled={saving}
            helper="Можно не выбирать вариант, а описать решение своими словами ниже."
          >
            <option value={CUSTOM_ANSWER}>— свой ответ —</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        )}

        <Textarea
          label={options.length > 0 ? 'Пояснение' : 'Ответ'}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={5}
          disabled={saving}
          placeholder={
            options.length > 0
              ? 'Уточните выбор или опишите решение своими словами'
              : 'Ответьте на вопрос исполнителя'
          }
        />
      </div>
    </Modal>
  );
}

/**
 * TASK-NEEDS-INPUT-001 — чистая подготовка строк доски «Нужна информация».
 *
 * Доска (GET /api/tasks/needs-input-board) отдаёт задачи в статусе NEEDS_INPUT:
 * агент-исполнитель упёрся в неоднозначность и ждёт ответа человека. Здесь —
 * только чистые функции (отбор, нормализация, сортировка, склейка ответа), чтобы
 * их можно было проверить тестом без рендера страницы.
 */
import type { NeedsInputTask } from '../../api/tasksApi';
import type { Project } from '../../types/project';

/** Заглушка для пустых ячеек таблицы (проект/сервис не пришли с сервера). */
export const EMPTY_CELL = '—';

/** Сколько символов вопроса показываем в таблице до сокращения. */
export const QUESTION_PREVIEW_LIMIT = 120;

/** Строка таблицы: всё уже приведено к виду для отрисовки. */
export interface NeedsInputRow {
  /** id задачи (он же ключ строки). */
  id: string;
  title: string;
  projectName: string;
  serviceCode: string;
  /** Полный текст вопроса — идёт в title у ячейки и в модалку. */
  question: string;
  /** Сокращённый вопрос для колонки таблицы. */
  questionPreview: string;
  /** Приоритет строкой ('0'..'3') — как его ждёт справочник taskPriorities. */
  priority: string;
  askedAt: string;
  /** Исходная задача: модалке нужны options/context/roleCode и id вопроса. */
  task: NeedsInputTask;
}

/**
 * Сократить длинный вопрос до превью. Режем по границе слова, чтобы в таблице не
 * оставался обрубок слова — полный текст всё равно виден в модалке.
 */
export function truncateQuestion(text: string, limit: number = QUESTION_PREVIEW_LIMIT): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  // Отступаем к последнему пробелу, только если он не в самом начале обрезка,
  // иначе от длинного слова осталась бы пара символов.
  const base = lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}

/**
 * Подготовить строки доски: подставить название проекта, нормализовать приоритет,
 * сократить вопрос и отсортировать очередь.
 *
 * Порядок задаём здесь, а не полагаемся на сервер: сначала более приоритетные
 * (0 — самый высокий), внутри одного приоритета — те, кто ждёт дольше. Человек
 * разбирает очередь сверху вниз, и задача не должна «утонуть» из-за того, что
 * вопрос по ней задали позже.
 *
 * Задачи с пустым текстом вопроса отбрасываем: показывать в очереди строку, на
 * которую нечего ответить, хуже, чем не показывать её вовсе.
 */
export function selectNeedsInputRows(
  tasks: NeedsInputTask[],
  projects: Project[] = [],
): NeedsInputRow[] {
  const projectNameById = new Map(projects.map((p) => [p.id, p.name]));

  const rows = tasks
    .filter((t) => Boolean(t.question?.question?.trim()))
    .map<NeedsInputRow>((task) => {
      const question = task.question.question.trim();
      // projectName с доски первичен; список проектов — запасной источник на
      // случай, если сервер отдал только projectId.
      const projectName =
        task.projectName?.trim() ||
        (task.projectId ? projectNameById.get(task.projectId) : undefined) ||
        EMPTY_CELL;
      return {
        id: task.id,
        title: task.title,
        projectName,
        serviceCode: task.serviceCode?.trim() || EMPTY_CELL,
        question,
        questionPreview: truncateQuestion(question),
        priority: task.priority,
        askedAt: task.question.askedAt,
        task,
      };
    });

  // Копия уже создана map(), сортируем её — исходный массив не мутируем.
  return rows.sort((a, b) => {
    const byPriority = Number(a.priority) - Number(b.priority);
    if (byPriority !== 0) return byPriority;
    return a.askedAt.localeCompare(b.askedAt);
  });
}

/**
 * Склеить ответ человека из выбранного варианта и свободного пояснения.
 *
 * Оба поля необязательны по отдельности, но вместе должны дать непустую строку —
 * агенту уходит один текст. Когда есть и вариант, и пояснение, вариант идёт
 * первым: агент читает ответ сверху вниз, и решение важнее его обоснования.
 */
export function composeAnswer(option: string, note: string): string {
  const parts = [option.trim(), note.trim()].filter(Boolean);
  return parts.join('\n');
}

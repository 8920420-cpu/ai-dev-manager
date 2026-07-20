import { describe, it, expect } from 'vitest';
import type { NeedsInputTask } from '../../api/tasksApi';
import type { Project } from '../../types/project';
import {
  QUESTION_PREVIEW_LIMIT,
  composeAnswer,
  selectNeedsInputRows,
  truncateQuestion,
} from './needsInputRows';

/** Заготовка задачи доски с переопределяемыми полями. */
function task(over: Partial<NeedsInputTask> & { question?: Partial<NeedsInputTask['question']> }): NeedsInputTask {
  const { question, ...rest } = over;
  return {
    id: 'id',
    title: 'Задача',
    projectId: 'p1',
    projectName: 'Проект',
    serviceCode: 'svc',
    priority: '2',
    ...rest,
    question: {
      id: 'q1',
      question: 'Какой формат даты использовать?',
      options: [],
      context: null,
      roleCode: 'PROGRAMMER',
      askedAt: '2026-07-01T10:00:00.000Z',
      ...question,
    },
  };
}

const PROJECTS: Project[] = [
  {
    id: 'p1',
    name: 'Альфа',
    path: '/repos/alpha',
    status: 'active',
    pauseReason: null,
    stages: [],
    roles: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

describe('selectNeedsInputRows — подготовка строк', () => {
  it('нормализует числовой приоритет в строку для справочника приоритетов', () => {
    const rows = selectNeedsInputRows([task({ priority: '0' })]);
    expect(rows[0].priority).toBe('0');
  });

  it('берёт название проекта из списка проектов, когда доска отдала только projectId', () => {
    const rows = selectNeedsInputRows([task({ projectName: null, projectId: 'p1' })], PROJECTS);
    expect(rows[0].projectName).toBe('Альфа');
  });

  it('ставит прочерк, если ни имени проекта, ни сервиса нет', () => {
    const rows = selectNeedsInputRows([task({ projectName: null, projectId: null, serviceCode: null })]);
    expect(rows[0].projectName).toBe('—');
    expect(rows[0].serviceCode).toBe('—');
  });

  it('отбрасывает задачи с пустым текстом вопроса — отвечать там нечего', () => {
    const rows = selectNeedsInputRows([
      task({ id: 'ok' }),
      task({ id: 'empty', question: { question: '   ' } }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['ok']);
  });

  it('сохраняет исходную задачу в строке — модалке нужны options и id вопроса', () => {
    const source = task({ question: { id: 'q-42', options: ['да', 'нет'] } });
    const rows = selectNeedsInputRows([source]);
    expect(rows[0].task).toBe(source);
    expect(rows[0].task.question.options).toEqual(['да', 'нет']);
  });
});

describe('selectNeedsInputRows — порядок очереди', () => {
  it('сначала более приоритетные, внутри приоритета — кто дольше ждёт', () => {
    const rows = selectNeedsInputRows([
      task({ id: 'low-new', priority: '3', question: { askedAt: '2026-07-05T10:00:00.000Z' } }),
      task({ id: 'high-new', priority: '1', question: { askedAt: '2026-07-05T10:00:00.000Z' } }),
      task({ id: 'high-old', priority: '1', question: { askedAt: '2026-07-01T10:00:00.000Z' } }),
      task({ id: 'orchestrator', priority: '0', question: { askedAt: '2026-07-09T10:00:00.000Z' } }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['orchestrator', 'high-old', 'high-new', 'low-new']);
  });

  it('не мутирует исходный список задач', () => {
    const board = [task({ id: 'b', priority: '3' }), task({ id: 'a', priority: '1' })];
    const before = board.map((t) => t.id);
    selectNeedsInputRows(board);
    expect(board.map((t) => t.id)).toEqual(before);
  });
});

describe('truncateQuestion — превью вопроса в таблице', () => {
  it('короткий вопрос оставляет как есть, без многоточия', () => {
    expect(truncateQuestion('Что делать?')).toBe('Что делать?');
  });

  it('схлопывает переносы строк в пробелы — таблица однострочная', () => {
    expect(truncateQuestion('Первая строка\n\nвторая строка')).toBe('Первая строка вторая строка');
  });

  it('длинный вопрос режет до лимита и добавляет многоточие', () => {
    const long = 'слово '.repeat(60).trim();
    const preview = truncateQuestion(long);
    expect(preview.length).toBeLessThanOrEqual(QUESTION_PREVIEW_LIMIT + 1);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('режет по границе слова, не оставляя обрубка', () => {
    const preview = truncateQuestion('раз два три четыре пять', 10);
    expect(preview).toBe('раз два…');
  });
});

describe('composeAnswer — склейка варианта и пояснения', () => {
  it('только вариант — уходит он один', () => {
    expect(composeAnswer('Вариант A', '')).toBe('Вариант A');
  });

  it('только пояснение — уходит свободный текст', () => {
    expect(composeAnswer('', 'Свой ответ')).toBe('Свой ответ');
  });

  it('вариант и пояснение — вариант первой строкой, пояснение второй', () => {
    expect(composeAnswer('Вариант A', 'Потому что так быстрее')).toBe(
      'Вариант A\nПотому что так быстрее',
    );
  });

  it('пробельный ввод считается пустым ответом', () => {
    expect(composeAnswer('   ', '\n  \t')).toBe('');
  });
});

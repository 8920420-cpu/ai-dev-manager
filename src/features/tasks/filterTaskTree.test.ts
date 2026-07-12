import { describe, it, expect } from 'vitest';
import type { TaskTree } from '../../api/tasksApi';
import { countDocsDebt, countTopLevelTasks, filterTaskTree } from './filterTaskTree';

const tree: TaskTree = {
  projects: [
    {
      id: 'p1',
      name: 'Проект',
      code: 'P',
      taskCount: 4,
      tasks: [
        {
          id: 't1',
          title: 'Активная',
          status: 'CODING',
          priority: 'P2',
          subtasks: [
            { id: 's1', title: 'Выполненная подзадача', status: 'DONE', priority: 'P2' },
            { id: 's2', title: 'Активная подзадача', status: 'REVIEW', priority: 'P2' },
            { id: 's3', title: 'Провальная подзадача', status: 'FAILED', priority: 'P2' },
          ],
        },
        { id: 't2', title: 'Выполненная', status: 'DONE', priority: 'P2', subtasks: [] },
        { id: 't3', title: 'Отменённая', status: 'CANCELLED', priority: 'P2', subtasks: [] },
        { id: 't4', title: 'Заблокированная', status: 'BLOCKED', priority: 'P1', subtasks: [] },
      ],
    },
  ],
};

describe('filterTaskTree — фильтр терминальных статусов (DONE/CANCELLED/FAILED)', () => {
  it('по умолчанию скрывает DONE/CANCELLED/FAILED, но оставляет BLOCKED, пересчитывает счётчик', () => {
    const out = filterTaskTree(tree, false);
    const project = out.projects[0]!;
    // t2 (DONE) и t3 (CANCELLED) скрыты; t1 (активная) и t4 (BLOCKED) остаются.
    expect(project.tasks.map((t) => t.id)).toEqual(['t1', 't4']);
    expect(project.taskCount).toBe(2);
    // Скрыты DONE-подзадача s1 и FAILED-подзадача s3; активная s2 остаётся.
    expect(project.tasks[0]!.subtasks.map((s) => s.id)).toEqual(['s2']);
  });

  it('при showDone=true возвращает дерево без изменений', () => {
    const out = filterTaskTree(tree, true);
    expect(out).toBe(tree);
    expect(out.projects[0]!.taskCount).toBe(4);
  });

  it('проект без активных задач остаётся в дереве с нулевым счётчиком', () => {
    const onlyClosed: TaskTree = {
      projects: [{ id: 'p2', name: 'Готовый', code: null, taskCount: 2, tasks: [
        { id: 'x', title: 'Готово', status: 'DONE', priority: 'P3', subtasks: [] },
        { id: 'y', title: 'Отменено', status: 'CANCELLED', priority: 'P3', subtasks: [] },
      ] }],
    };
    const out = filterTaskTree(onlyClosed, false);
    expect(out.projects).toHaveLength(1);
    expect(out.projects[0]!.taskCount).toBe(0);
    expect(countTopLevelTasks(out)).toBe(0);
  });

  it('countTopLevelTasks суммирует задачи верхнего уровня по проектам', () => {
    expect(countTopLevelTasks(tree)).toBe(4);
  });
});

describe('countDocsDebt — счётчик непогашенного документационного долга', () => {
  it('считает задачи и подзадачи с docsDebt != null', () => {
    const withDebt: TaskTree = {
      projects: [
        {
          id: 'p1',
          name: 'Проект',
          code: 'P',
          taskCount: 2,
          tasks: [
            {
              id: 't1',
              title: 'С долгом',
              status: 'REVIEW',
              priority: 'P2',
              docsDebt: {
                role: 'DOCUMENTATION_AUDITOR',
                reason: 'нет описания API',
                status: 'BLOCKED',
                at: '2026-07-09T00:00:00.000Z',
              },
              subtasks: [
                {
                  id: 's1',
                  title: 'Подзадача с долгом',
                  status: 'CODING',
                  priority: 'P2',
                  docsDebt: {
                    role: 'DOCUMENTATION_KEEPER',
                    reason: 'нет changelog',
                    status: 'BLOCKED',
                    at: '2026-07-09T00:00:00.000Z',
                  },
                },
                { id: 's2', title: 'Без долга', status: 'CODING', priority: 'P2', docsDebt: null },
              ],
            },
            { id: 't2', title: 'Без долга', status: 'CODING', priority: 'P2', subtasks: [] },
          ],
        },
      ],
    };
    expect(countDocsDebt(withDebt)).toBe(2);
  });

  it('возвращает 0, когда долга нет ни у одного узла', () => {
    expect(countDocsDebt(tree)).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import type { TaskTree } from '../../api/tasksApi';
import { countTopLevelTasks, filterTaskTree } from './filterTaskTree';

const tree: TaskTree = {
  projects: [
    {
      id: 'p1',
      name: 'Проект',
      code: 'P',
      taskCount: 2,
      tasks: [
        {
          id: 't1',
          title: 'Активная',
          status: 'CODING',
          priority: 'P2',
          subtasks: [
            { id: 's1', title: 'Выполненная подзадача', status: 'DONE', priority: 'P2' },
            { id: 's2', title: 'Активная подзадача', status: 'REVIEW', priority: 'P2' },
          ],
        },
        { id: 't2', title: 'Выполненная', status: 'DONE', priority: 'P2', subtasks: [] },
      ],
    },
  ],
};

describe('filterTaskTree — фильтр выполненных (DONE)', () => {
  it('по умолчанию скрывает DONE-задачи и DONE-подзадачи, пересчитывает счётчик', () => {
    const out = filterTaskTree(tree, false);
    const project = out.projects[0]!;
    // DONE-задача t2 скрыта → остаётся одна задача верхнего уровня.
    expect(project.tasks.map((t) => t.id)).toEqual(['t1']);
    expect(project.taskCount).toBe(1);
    // DONE-подзадача s1 скрыта, активная s2 остаётся.
    expect(project.tasks[0]!.subtasks.map((s) => s.id)).toEqual(['s2']);
  });

  it('при showDone=true возвращает дерево без изменений', () => {
    const out = filterTaskTree(tree, true);
    expect(out).toBe(tree);
    expect(out.projects[0]!.taskCount).toBe(2);
  });

  it('проект без активных задач остаётся в дереве с нулевым счётчиком', () => {
    const onlyDone: TaskTree = {
      projects: [{ id: 'p2', name: 'Готовый', code: null, taskCount: 1, tasks: [
        { id: 'x', title: 'Готово', status: 'DONE', priority: 'P3', subtasks: [] },
      ] }],
    };
    const out = filterTaskTree(onlyDone, false);
    expect(out.projects).toHaveLength(1);
    expect(out.projects[0]!.taskCount).toBe(0);
    expect(countTopLevelTasks(out)).toBe(0);
  });

  it('countTopLevelTasks суммирует задачи верхнего уровня по проектам', () => {
    expect(countTopLevelTasks(tree)).toBe(2);
  });
});

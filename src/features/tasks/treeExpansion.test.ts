import { describe, it, expect } from 'vitest';
import { expandedForLoad, projectKey, taskKey } from './treeExpansion';

describe('treeExpansion — состояние раскрытия дерева задач', () => {
  it('projectKey/taskKey формируют ожидаемые ключи узлов', () => {
    expect(projectKey('p1')).toBe('p:p1');
    expect(taskKey('t1')).toBe('t:t1');
  });

  it('первая загрузка (initial=true) раскрывает все проекты', () => {
    const out = expandedForLoad(new Set(), ['p1', 'p2'], true);
    expect([...out].sort()).toEqual(['p:p1', 'p:p2']);
  });

  it('обновление (initial=false) сохраняет раскрытие пользователя без изменений', () => {
    // Пользователь свернул проект p2 и раскрыл задачу t9.
    const prev = new Set(['p:p1', 't:t9']);
    const out = expandedForLoad(prev, ['p1', 'p2'], false);
    // Набор не пересобирается: p2 не раскрывается принудительно, t9 сохранён.
    expect(out).toBe(prev);
    expect(out.has('p:p2')).toBe(false);
    expect(out.has('t:t9')).toBe(true);
  });

  it('первая загрузка отбрасывает раскрытые задачи (дерево открывается на уровне проектов)', () => {
    const out = expandedForLoad(new Set(['t:t9']), ['p1'], true);
    expect([...out]).toEqual(['p:p1']);
    expect(out.has('t:t9')).toBe(false);
  });
});

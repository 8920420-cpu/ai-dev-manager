import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { RouterProvider, useRouter } from './router';
import { NAV_ITEMS } from './nav';

beforeEach(() => {
  window.location.hash = '';
});

describe('router — раздел «Задачи»', () => {
  it('#/tasks разбирается в маршрут tasks', () => {
    window.location.hash = '#/tasks';
    const { result } = renderHook(() => useRouter(), { wrapper: RouterProvider });
    expect(result.current.route).toBe('tasks');
  });

  it('href(tasks) → #/tasks', () => {
    const { result } = renderHook(() => useRouter(), { wrapper: RouterProvider });
    expect(result.current.href('tasks')).toBe('#/tasks');
  });

  it('navigate(tasks) обновляет hash и маршрут', () => {
    const { result } = renderHook(() => useRouter(), { wrapper: RouterProvider });
    act(() => result.current.navigate('tasks'));
    expect(window.location.hash).toBe('#/tasks');
    expect(result.current.route).toBe('tasks');
  });
});

describe('nav — пункт «Задачи»', () => {
  it('боковое меню содержит пункт «Задачи» с маршрутом tasks', () => {
    const item = NAV_ITEMS.find((i) => i.route === 'tasks');
    expect(item).toBeDefined();
    expect(item!.label).toBe('Задачи');
  });
});

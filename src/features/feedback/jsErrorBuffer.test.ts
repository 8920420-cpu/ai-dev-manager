import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordJsError,
  getRecentJsErrors,
  clearJsErrors,
  installJsErrorCapture,
} from './jsErrorBuffer';

describe('jsErrorBuffer', () => {
  beforeEach(() => clearJsErrors());

  it('записывает ошибку и отдаёт её в снимке', () => {
    recordJsError('boom');
    expect(getRecentJsErrors().some((e) => e.includes('boom'))).toBe(true);
  });

  it('пустые/пробельные записи игнорируются', () => {
    recordJsError('   ');
    expect(getRecentJsErrors()).toHaveLength(0);
  });

  it('кольцевой буфер ограничен по размеру', () => {
    for (let i = 0; i < 50; i += 1) recordJsError(`err-${i}`);
    const all = getRecentJsErrors();
    expect(all.length).toBeLessThanOrEqual(20);
    // Свежие остаются, самые старые вытеснены.
    expect(all.some((e) => e.includes('err-49'))).toBe(true);
    expect(all.some((e) => e.includes('err-0'))).toBe(false);
  });

  it('перехватывает событие window "error"', () => {
    const teardown = installJsErrorCapture();
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'runtime-oops',
        filename: 'a.js',
        lineno: 3,
        colno: 4,
      }),
    );
    expect(getRecentJsErrors().some((e) => e.includes('runtime-oops'))).toBe(true);
    teardown();
  });
});

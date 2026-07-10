import { describe, it, expect } from 'vitest';
import { isAbsolutePath, required } from './validation';

describe('isAbsolutePath', () => {
  it('принимает POSIX-путь', () => {
    expect(isAbsolutePath('/home/user/app')).toBe(true);
    expect(isAbsolutePath('/')).toBe(true);
  });

  it('принимает Windows-диск с обоими разделителями', () => {
    expect(isAbsolutePath('C:\\projects\\app')).toBe(true);
    expect(isAbsolutePath('D:/projects/app')).toBe(true);
  });

  it('принимает UNC-путь', () => {
    expect(isAbsolutePath('\\\\server\\share')).toBe(true);
  });

  it('отклоняет относительный/пустой путь', () => {
    expect(isAbsolutePath('src/app')).toBe(false);
    expect(isAbsolutePath('./app')).toBe(false);
    expect(isAbsolutePath('..\\app')).toBe(false);
    expect(isAbsolutePath('app')).toBe(false);
    expect(isAbsolutePath('')).toBe(false);
    expect(isAbsolutePath('   ')).toBe(false);
  });

  it('игнорирует обрамляющие пробелы', () => {
    expect(isAbsolutePath('  /home/app  ')).toBe(true);
  });
});

describe('required', () => {
  it('возвращает ошибку для пустого значения и null для непустого', () => {
    expect(required('', 'Поле')).toMatch(/обязательно/);
    expect(required('   ')).toMatch(/обязательно/);
    expect(required('значение')).toBeNull();
  });
});

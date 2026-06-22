import { describe, it, expect } from 'vitest';
import {
  PRESET_ROLES,
  PRESET_ROLE_NAMES,
  SCANNER_ROLE_CODE,
  isScannerRole,
  roleCanonicalCode,
} from './presets';

describe('пресеты ролей и определение Scanner', () => {
  it('PRESET_ROLE_NAMES соответствует именам PRESET_ROLES', () => {
    expect(PRESET_ROLE_NAMES).toEqual(PRESET_ROLES.map((r) => r.name));
  });

  it('Scanner определяется по каноническому коду', () => {
    expect(isScannerRole({ name: 'Scanner', code: SCANNER_ROLE_CODE })).toBe(true);
    expect(isScannerRole({ name: 'Любое название', code: 'SCANNER' })).toBe(true);
  });

  it('роль с другим кодом не считается Scanner, даже если в названии есть «scanner»', () => {
    // Ключевое требование P0.1: не распознавать Scanner по строке в названии.
    expect(isScannerRole({ name: 'Scanner Pro', code: 'PROGRAMMER' })).toBe(false);
    expect(isScannerRole({ name: 'Сканер документов', code: 'PROGRAMMER' })).toBe(false);
  });

  it('пользовательская роль с произвольным названием без кода не считается Scanner', () => {
    expect(isScannerRole({ name: 'Мой сканер' })).toBe(false);
    expect(isScannerRole({ name: 'scanner-of-things' })).toBe(false);
  });

  it('бэкафилл кода по точному пресетному имени (миграция старых данных)', () => {
    expect(roleCanonicalCode({ name: 'Scanner' })).toBe('SCANNER');
    expect(roleCanonicalCode({ name: 'Programmer' })).toBe('PROGRAMMER');
    // Неточное имя не сопоставляется ни с каким кодом.
    expect(roleCanonicalCode({ name: 'Scanner Pro' })).toBeUndefined();
  });

  it('явный код приоритетнее имени', () => {
    expect(roleCanonicalCode({ name: 'Scanner', code: 'PROGRAMMER' })).toBe('PROGRAMMER');
  });
});

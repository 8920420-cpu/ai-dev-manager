import { describe, expect, it } from 'vitest';
import { cancelReasonLabel } from './cancelReasons';

describe('cancelReasonLabel', () => {
  it('переводит известные машинные коды в русский', () => {
    expect(cancelReasonLabel('duplicate_closed')).toBe('Закрыта как дубликат');
    expect(cancelReasonLabel('architect_split_recursion_debris')).toBe(
      'Убрана: обломок расщепления Архитектора',
    );
    expect(cancelReasonLabel('legacy_recursive_epic_cleanup')).toBe(
      'Убрана при чистке рекурсивного эпика',
    );
    expect(cancelReasonLabel('superseded_by_rerun')).toBe('Заменена повторным прогоном');
    expect(cancelReasonLabel('smoke_test_cleanup')).toBe('Убрана после smoke-теста');
    expect(cancelReasonLabel('blocked_duplicate_cleanup')).toBe(
      'Убрана при чистке заблокированных дублей',
    );
  });

  it('пропускает готовую русскую заметку как есть', () => {
    const note = 'Дубль живой задачи abc (совпал отпечаток текста): закрыт автоматически';
    expect(cancelReasonLabel(note)).toBe(note);
  });

  it('«голый» UUID трактует как ссылку на оригинал дубля', () => {
    expect(cancelReasonLabel('dd46f291-b454-4930-a71f-8e09528ab3b7')).toBe(
      'Закрыта как дубликат другой задачи',
    );
  });

  it('пусто/нет причины → «Причина не указана»', () => {
    expect(cancelReasonLabel(null)).toBe('Причина не указана');
    expect(cancelReasonLabel(undefined)).toBe('Причина не указана');
    expect(cancelReasonLabel('   ')).toBe('Причина не указана');
  });
});

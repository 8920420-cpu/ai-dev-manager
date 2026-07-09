// PROGRAMMER-MODEL-ROUTING-001 — модель программиста по сложности задачи.
// subtask (мелкая подзадача-на-файл) → простая модель; всё прочее (service/legacy)
// → сложная. Имена берутся из env-переопределяемых дефолтов; здесь проверяем сам
// выбор ветки, а не конкретные строки моделей (они меняются со сменой поколений).
import test from 'node:test';
import assert from 'node:assert/strict';
import { programmerModelForKind } from '../src/db.js';

test('programmerModelForKind: subtask и service дают РАЗНЫЕ модели', () => {
  const simple = programmerModelForKind('subtask');
  const complex = programmerModelForKind('service');
  assert.ok(simple, 'модель для subtask задана');
  assert.ok(complex, 'модель для service задана');
  assert.notEqual(simple, complex, 'подзадача и цельный сервис едут на разных моделях');
});

test('programmerModelForKind: только subtask считается простым', () => {
  const simple = programmerModelForKind('subtask');
  // Всё, что не subtask (service, epic-как-fallback, null), — сложная ветка.
  assert.equal(programmerModelForKind('service'), programmerModelForKind('epic'));
  assert.equal(programmerModelForKind('service'), programmerModelForKind(null));
  assert.notEqual(programmerModelForKind('service'), simple);
});

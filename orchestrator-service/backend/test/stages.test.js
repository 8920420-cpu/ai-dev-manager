import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAbsolutePath,
  normalizeWatchDirectory,
  isScannerStage,
  validateStages,
  STAGE_ERROR,
  SCANNER_ROLE_CODE,
} from '../src/stages.js';

test('isAbsolutePath: Windows-диск, UNC и POSIX — абсолютные', () => {
  assert.equal(isAbsolutePath('K:\\projects\\my-service'), true);
  assert.equal(isAbsolutePath('C:/projects/app'), true);
  assert.equal(isAbsolutePath('\\\\server\\share'), true);
  assert.equal(isAbsolutePath('/home/user/app'), true);
});

test('isAbsolutePath: относительный/пустой/без разделителя — не абсолютные', () => {
  assert.equal(isAbsolutePath('src/app'), false);
  assert.equal(isAbsolutePath('./app'), false);
  assert.equal(isAbsolutePath('C:file'), false);
  assert.equal(isAbsolutePath(''), false);
  assert.equal(isAbsolutePath(undefined), false);
});

test('normalizeWatchDirectory: пробелы тримятся, пустая строка → null', () => {
  assert.equal(normalizeWatchDirectory('  /a/b  '), '/a/b');
  assert.equal(normalizeWatchDirectory('   '), null);
  assert.equal(normalizeWatchDirectory(''), null);
  assert.equal(normalizeWatchDirectory(undefined), null);
});

test('isScannerStage: только по коду роли SCANNER, не по имени', () => {
  assert.equal(isScannerStage({ name: 'Scanner', roleCodes: ['PROGRAMMER'] }), false);
  assert.equal(isScannerStage({ name: 'Наблюдатель', roleCodes: [SCANNER_ROLE_CODE] }), true);
  assert.equal(isScannerStage({ roleCodes: [] }), false);
});

test('validateStages: по умолчанию этап включён (нет поля enabled)', () => {
  const errors = validateStages([{ id: 's1', name: 'Разработка', roleCodes: ['PROGRAMMER'] }]);
  assert.equal(errors.length, 0);
});

test('validateStages: имя этапа обязательно', () => {
  const errors = validateStages([{ id: 's1', name: '  ', roleCodes: ['PROGRAMMER'] }]);
  assert.ok(errors.some((e) => e.stageId === 's1' && e.code === STAGE_ERROR.NAME_REQUIRED));
});

test('validateStages: включённый Scanner без папки → required', () => {
  const errors = validateStages([
    { id: 's1', name: 'Скан', enabled: true, roleCodes: [SCANNER_ROLE_CODE] },
  ]);
  assert.deepEqual(
    errors.filter((e) => e.stageId === 's1').map((e) => e.code),
    [STAGE_ERROR.WATCH_DIR_REQUIRED],
  );
});

test('validateStages: включённый Scanner с относительным путём → must_be_absolute', () => {
  const errors = validateStages([
    { id: 's1', name: 'Скан', enabled: true, roleCodes: [SCANNER_ROLE_CODE], watchDirectory: 'src/app' },
  ]);
  assert.ok(errors.some((e) => e.stageId === 's1' && e.code === STAGE_ERROR.WATCH_DIR_ABSOLUTE));
});

test('validateStages: включённый Scanner с абсолютным путём → ок', () => {
  const errors = validateStages([
    { id: 's1', name: 'Скан', enabled: true, roleCodes: [SCANNER_ROLE_CODE], watchDirectory: 'K:\\projects\\x' },
  ]);
  assert.equal(errors.length, 0);
});

test('validateStages: отключённый Scanner без папки сохраняется (нет ошибки)', () => {
  const errors = validateStages([
    { id: 's1', name: 'Скан', enabled: false, roleCodes: [SCANNER_ROLE_CODE] },
  ]);
  assert.equal(errors.length, 0);
});

test('validateStages: переименование не отключает проверку — признак по коду роли', () => {
  // Имя «Развёртывание», но роль SCANNER → валидация Scanner всё равно работает.
  const errors = validateStages([
    { id: 's1', name: 'Развёртывание', enabled: true, roleCodes: [SCANNER_ROLE_CODE] },
  ]);
  assert.ok(errors.some((e) => e.code === STAGE_ERROR.WATCH_DIR_REQUIRED));
});

test('validateStages: смена роли со SCANNER на другую снимает требование папки', () => {
  const errors = validateStages([
    { id: 's1', name: 'Этап', enabled: true, roleCodes: ['PROGRAMMER'] },
  ]);
  assert.equal(errors.length, 0);
});

test('validateStages: несколько включённых SCANNER → конфликт на каждом', () => {
  const errors = validateStages([
    { id: 's1', name: 'A', enabled: true, roleCodes: [SCANNER_ROLE_CODE], watchDirectory: '/a' },
    { id: 's2', name: 'B', enabled: true, roleCodes: [SCANNER_ROLE_CODE], watchDirectory: '/b' },
  ]);
  const conflicts = errors.filter((e) => e.code === STAGE_ERROR.SCANNER_CONFLICT).map((e) => e.stageId);
  assert.deepEqual(conflicts.sort(), ['s1', 's2']);
});

test('validateStages: один включённый Scanner + один отключённый Scanner — без конфликта', () => {
  const errors = validateStages([
    { id: 's1', name: 'A', enabled: true, roleCodes: [SCANNER_ROLE_CODE], watchDirectory: '/a' },
    { id: 's2', name: 'B', enabled: false, roleCodes: [SCANNER_ROLE_CODE] },
  ]);
  assert.equal(errors.filter((e) => e.code === STAGE_ERROR.SCANNER_CONFLICT).length, 0);
});

test('validateStages: порядок этапов не влияет на валидацию (reorder)', () => {
  const a = { id: 's1', name: 'A', enabled: true, roleCodes: ['PROGRAMMER'] };
  const b = { id: 's2', name: 'B', enabled: true, roleCodes: [SCANNER_ROLE_CODE], watchDirectory: '/b' };
  assert.deepEqual(validateStages([a, b]), validateStages([b, a]));
});

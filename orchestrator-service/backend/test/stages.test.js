import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAbsolutePath,
  normalizeWatchDirectory,
  normalizeTaskStatus,
  isScannerStage,
  validateStages,
  STAGE_ERROR,
  SCANNER_ROLE_CODE,
} from '../src/stages.js';

// Хелпер: валидный включённый Scanner-этап с папкой и статусом.
const scannerStage = (id, overrides = {}) => ({
  id, name: id, enabled: true, roleCodes: [SCANNER_ROLE_CODE],
  watchDirectory: '/abs', taskStatus: 'CODING', ...overrides,
});

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

test('validateStages: этап без enabled читается как включённый (LEGACY-STAGE-DEFAULTS, absent = true)', () => {
  // Старые записи без поля enabled трактуются как включённые — поэтому
  // включённый не-Scanner этап обязан иметь task_status (как любой включённый),
  // а отдельной ошибки про enabled нет.
  const errors = validateStages([
    { id: 's1', name: 'Разработка', roleCodes: ['PROGRAMMER'], taskStatus: 'CODING' },
  ]);
  assert.equal(errors.length, 0);
});

test('validateStages: любое не-false значение enabled трактуется как включён (только явный false отключает)', () => {
  // Зеркалит фронтендовый isStageEnabled = enabled !== false: отсутствие и любое
  // значение кроме явного false → включён. Само значение enabled ошибкой не является.
  for (const truthy of [undefined, null, 'true', 1, 0]) {
    const errors = validateStages([
      { id: 's1', name: 'Этап', enabled: truthy, roleCodes: ['SCANNER'], watchDirectory: '/abs', taskStatus: 'CODING' },
    ]);
    // Включённый Scanner с папкой и статусом валиден — значит этап считается включённым.
    assert.equal(errors.length, 0, `enabled=${JSON.stringify(truthy)} должен трактоваться как включён`);
  }
  // Явный false → этап отключён: Scanner без папки/статуса допустим.
  const disabled = validateStages([
    { id: 's1', name: 'Этап', enabled: false, roleCodes: ['SCANNER'] },
  ]);
  assert.equal(disabled.length, 0);
});

test('validateStages: явный enabled:false валиден (без ошибки enabled)', () => {
  const errors = validateStages([{ id: 's1', name: 'Этап', enabled: false, roleCodes: ['PROGRAMMER'] }]);
  assert.equal(errors.length, 0);
});

test('validateStages: имя этапа обязательно', () => {
  const errors = validateStages([{ id: 's1', name: '  ', enabled: true, roleCodes: ['PROGRAMMER'] }]);
  assert.ok(errors.some((e) => e.stageId === 's1' && e.code === STAGE_ERROR.NAME_REQUIRED));
});

test('validateStages: включённый Scanner без папки → required', () => {
  const errors = validateStages([
    { id: 's1', name: 'Скан', enabled: true, roleCodes: [SCANNER_ROLE_CODE], taskStatus: 'CODING' },
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

test('validateStages: включённый Scanner с абсолютным путём и статусом → ок', () => {
  const errors = validateStages([
    { id: 's1', name: 'Скан', enabled: true, roleCodes: [SCANNER_ROLE_CODE], watchDirectory: 'K:\\projects\\x', taskStatus: 'CODING' },
  ]);
  assert.equal(errors.length, 0);
});

test('validateStages: включённый Scanner без статуса → scanner_task_status_required', () => {
  const errors = validateStages([
    { id: 's1', name: 'Скан', enabled: true, roleCodes: [SCANNER_ROLE_CODE], watchDirectory: '/abs' },
  ]);
  assert.deepEqual(
    errors.filter((e) => e.stageId === 's1').map((e) => e.code),
    [STAGE_ERROR.STATUS_REQUIRED],
  );
});

test('validateStages: Scanner с невалидным статусом → scanner_task_status_invalid', () => {
  const errors = validateStages([
    scannerStage('s1', { taskStatus: 'NONSENSE' }),
  ]);
  assert.ok(errors.some((e) => e.stageId === 's1' && e.code === STAGE_ERROR.STATUS_INVALID));
});

test('validateStages: статус нормализуется к верхнему регистру (coding → CODING валиден)', () => {
  const errors = validateStages([scannerStage('s1', { taskStatus: 'coding' })]);
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
  // PIPELINE-DYNAMIC-ROUTE-001: у не-Scanner включённого этапа папка не нужна,
  // но обязателен task_status (по нему резолвер ведёт задачу) — задаём его.
  const errors = validateStages([
    { id: 's1', name: 'Этап', enabled: true, roleCodes: ['PROGRAMMER'], taskStatus: 'CODING' },
  ]);
  assert.equal(errors.length, 0);
});

test('validateStages: включённый не-Scanner этап без task_status → stage_task_status_required', () => {
  const errors = validateStages([
    { id: 's1', name: 'Этап', enabled: true, roleCodes: ['PROGRAMMER'] },
  ]);
  assert.ok(errors.some((e) => e.code === STAGE_ERROR.STAGE_STATUS_REQUIRED));
});

test('validateStages: несколько включённых SCANNER с ОДНИМ статусом → конфликт на каждом', () => {
  const errors = validateStages([
    scannerStage('s1', { taskStatus: 'CODING' }),
    scannerStage('s2', { taskStatus: 'CODING' }),
  ]);
  const conflicts = errors.filter((e) => e.code === STAGE_ERROR.SCANNER_CONFLICT).map((e) => e.stageId);
  assert.deepEqual(conflicts.sort(), ['s1', 's2']);
});

test('validateStages: несколько включённых SCANNER с РАЗНЫМИ статусами → без конфликта', () => {
  const errors = validateStages([
    scannerStage('s1', { taskStatus: 'CODING' }),
    scannerStage('s2', { taskStatus: 'REVIEW' }),
  ]);
  assert.equal(errors.filter((e) => e.code === STAGE_ERROR.SCANNER_CONFLICT).length, 0);
  assert.equal(errors.length, 0);
});

test('validateStages: один включённый Scanner + один отключённый Scanner — без конфликта', () => {
  const errors = validateStages([
    scannerStage('s1', { taskStatus: 'CODING' }),
    { id: 's2', name: 'B', enabled: false, roleCodes: [SCANNER_ROLE_CODE] },
  ]);
  assert.equal(errors.filter((e) => e.code === STAGE_ERROR.SCANNER_CONFLICT).length, 0);
});

test('validateStages: отключённый Scanner с тем же статусом не конфликтует с включённым', () => {
  const errors = validateStages([
    scannerStage('s1', { taskStatus: 'CODING' }),
    { id: 's2', name: 'B', enabled: false, roleCodes: [SCANNER_ROLE_CODE], taskStatus: 'CODING' },
  ]);
  assert.equal(errors.filter((e) => e.code === STAGE_ERROR.SCANNER_CONFLICT).length, 0);
});

test('validateStages: порядок этапов не влияет на валидацию (reorder)', () => {
  const a = { id: 's1', name: 'A', enabled: true, roleCodes: ['PROGRAMMER'] };
  const b = scannerStage('s2', { name: 'B', watchDirectory: '/b', taskStatus: 'CODING' });
  assert.deepEqual(validateStages([a, b]), validateStages([b, a]));
});

test('normalizeTaskStatus: верхний регистр, тримминг, пустое → null', () => {
  assert.equal(normalizeTaskStatus('  coding '), 'CODING');
  assert.equal(normalizeTaskStatus('REVIEW'), 'REVIEW');
  assert.equal(normalizeTaskStatus('   '), null);
  assert.equal(normalizeTaskStatus(undefined), null);
});

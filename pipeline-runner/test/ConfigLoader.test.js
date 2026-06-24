import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { ConfigLoader, ConfigError } from '../src/ConfigLoader.js';
import { tmpDir } from './helpers.js';

const loader = new ConfigLoader();

// Канонический формат этапа (LEGACY-PIPELINE-CONFIG-001):
//   { "commands": string[], "enabled": true|false }
// Оба поля обязательны. Старый массивный формат и объект без enabled
// отклоняются ConfigError до запуска команд.
const stage = (commands, enabled = true) => ({ commands, enabled });

test('validate принимает корректный конфиг и нормализует поля', () => {
  const cfg = loader.validate(
    {
      name: 'Catalog_Service',
      workingDirectory: '.',
      timeoutMinutes: 30,
      stages: { test: stage(['go test ./...']), build: stage(['docker compose build']) },
    },
    path.resolve('/proj/.pipeline.json'),
  );

  assert.equal(cfg.name, 'Catalog_Service');
  assert.equal(cfg.timeoutMinutes, 30);
  assert.equal(cfg.workingDirectory, path.resolve('/proj'));
  assert.equal(cfg.configPath, path.resolve('/proj/.pipeline.json'));
  assert.deepEqual(
    cfg.stages.map((s) => s.name),
    ['test', 'build'],
  );
});

test('validate сохраняет порядок этапов из JSON', () => {
  const cfg = loader.validate({
    stages: { terraform: stage([]), deploy: stage([]), check: stage([]) },
  });
  assert.deepEqual(
    cfg.stages.map((s) => s.name),
    ['terraform', 'deploy', 'check'],
  );
});

test('validate подставляет значения по умолчанию', () => {
  const cfg = loader.validate({ stages: { build: stage(['echo hi']) } });
  assert.equal(cfg.name, 'pipeline');
  assert.equal(cfg.timeoutMinutes, null);
});

test('validate требует объект stages', () => {
  assert.throws(() => loader.validate({}), ConfigError);
  assert.throws(() => loader.validate({ stages: [] }), ConfigError);
  assert.throws(() => loader.validate(null), ConfigError);
});

test('validate: старый формат массива команд ОТКЛОНЯЕТСЯ (LEGACY-PIPELINE-CONFIG-001)', () => {
  assert.throws(
    () => loader.validate({ stages: { build: ['echo hi'] } }),
    (e) => e instanceof ConfigError && /build/.test(e.message),
  );
});

test('validate: этап-строка отклоняется как не-объект', () => {
  assert.throws(() => loader.validate({ stages: { test: 'go test' } }), ConfigError);
});

test('validate: объектный формат этапа с enabled', () => {
  const cfg = loader.validate({
    stages: {
      build: { commands: ['echo hi'], enabled: true },
      smoke: { commands: ['curl x'], enabled: false },
    },
  });
  assert.deepEqual(
    cfg.stages.map((s) => [s.name, s.enabled]),
    [
      ['build', true],
      ['smoke', false],
    ],
  );
  assert.deepEqual(cfg.stages[1].commands, ['curl x']);
});

test('validate: объект без enabled ОТКЛОНЯЕТСЯ — enabled обязателен (нет неявного включения)', () => {
  assert.throws(
    () => loader.validate({ stages: { build: { commands: ['echo hi'] } } }),
    (e) => e instanceof ConfigError && /enabled/.test(e.message),
  );
});

test('validate: объектный этап требует массив commands', () => {
  assert.throws(
    () => loader.validate({ stages: { build: { commands: 'echo', enabled: true } } }),
    ConfigError,
  );
  assert.throws(() => loader.validate({ stages: { build: { enabled: true } } }), ConfigError);
});

test('validate: enabled должно быть boolean', () => {
  assert.throws(
    () => loader.validate({ stages: { build: { commands: [], enabled: 'yes' } } }),
    ConfigError,
  );
});

test('validate: отключённый этап с пустыми командами допустим', () => {
  const cfg = loader.validate({ stages: { smoke: { commands: [], enabled: false } } });
  assert.equal(cfg.stages[0].enabled, false);
  assert.deepEqual(cfg.stages[0].commands, []);
});

test('validate требует строковые команды', () => {
  assert.throws(() => loader.validate({ stages: { test: stage([123]) } }), ConfigError);
});

test('validate отклоняет пустой набор этапов', () => {
  assert.throws(() => loader.validate({ stages: {} }), ConfigError);
});

test('validate проверяет timeoutMinutes', () => {
  assert.throws(() => loader.validate({ stages: { a: stage([]) }, timeoutMinutes: -1 }), ConfigError);
  assert.throws(() => loader.validate({ stages: { a: stage([]) }, timeoutMinutes: 'x' }), ConfigError);
});

test('load читает файл и парсит JSON', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, '.pipeline.json');
  writeFileSync(file, JSON.stringify({ name: 'X', stages: { test: stage(['echo hi']) } }));
  const cfg = await loader.load(file);
  assert.equal(cfg.name, 'X');
  assert.equal(cfg.workingDirectory, path.resolve(dir));
});

test('load бросает ConfigError на отсутствующем файле', async () => {
  await assert.rejects(() => loader.load('/no/such/.pipeline.json'), ConfigError);
});

test('load бросает ConfigError на битом JSON', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, '.pipeline.json');
  writeFileSync(file, '{ not json');
  await assert.rejects(() => loader.load(file), ConfigError);
});

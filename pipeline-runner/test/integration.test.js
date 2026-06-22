import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { runPipeline } from '../src/index.js';
import { Logger } from '../src/Logger.js';
import { tmpDir } from './helpers.js';

/**
 * Сквозной тест: реальный конфиг-файл + реальные процессы (echo / exit),
 * без подмены зависимостей. Логгер пишет в настоящий pipeline.log,
 * но эхо в stderr отключаем, чтобы не шуметь в выводе тестов.
 */
const quietLogger = (logPath) => new Logger(logPath, { echo: false });

function writeConfig(dir, cfg) {
  const file = path.join(dir, '.pipeline.json');
  writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

test('сквозной успешный прогон через реальный shell', async (t) => {
  const dir = tmpDir(t);
  const file = writeConfig(dir, {
    name: 'IntegrationOK',
    workingDirectory: '.',
    timeoutMinutes: 5,
    stages: {
      prepare: ['echo prepare_step'],
      test: ['echo test_step'],
    },
  });

  const result = await runPipeline({ configPath: file, deps: { createLogger: quietLogger } });

  assert.equal(result.success, true);
  const runDir = path.join(dir, '.tmp', 'pipeline-results', result.runId);
  const summary = JSON.parse(readFileSync(path.join(runDir, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'success');
  assert.equal(summary.stages.length, 2);
  assert.ok(existsSync(path.join(runDir, 'pipeline.log')));
});

test('сквозной прогон с отключённым этапом: SKIPPED, команда не запущена', async (t) => {
  const dir = tmpDir(t);
  const marker = path.join(dir, 'ran.txt');
  const file = writeConfig(dir, {
    name: 'IntegrationSkip',
    workingDirectory: '.',
    timeoutMinutes: 5,
    stages: {
      prepare: ['echo prepare_step'],
      smoke: { commands: [`node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}','x')"`], enabled: false },
      finish: ['echo finish_step'],
    },
  });

  const result = await runPipeline({ configPath: file, deps: { createLogger: quietLogger } });

  assert.equal(result.success, true);
  // команда отключённого этапа не выполнялась — файл-маркер не создан
  assert.equal(existsSync(marker), false);

  const runDir = path.join(dir, '.tmp', 'pipeline-results', result.runId);
  const summary = JSON.parse(readFileSync(path.join(runDir, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'success');
  assert.equal(summary.stages.length, 3);
  assert.equal(summary.stages[1].status, 'SKIPPED');
  assert.equal(summary.stages[1].reason, 'disabled_by_configuration');

  // лог содержит явную отметку о пропуске, не маскируя его под успех
  const log = readFileSync(path.join(runDir, 'pipeline.log'), 'utf8');
  assert.match(log, /disabled_by_configuration/);
});

test('сквозной прогон с падением: failedStage и остановка', async (t) => {
  const dir = tmpDir(t);
  const file = writeConfig(dir, {
    name: 'IntegrationFail',
    workingDirectory: '.',
    stages: {
      test: ['echo ok'],
      build: ['exit 1'],
      deploy: ['echo should_not_run'],
    },
  });

  const result = await runPipeline({ configPath: file, deps: { createLogger: quietLogger } });

  assert.equal(result.success, false);
  assert.equal(result.failedStage, 'build');

  const runDir = path.join(dir, '.tmp', 'pipeline-results', result.runId);
  const summary = JSON.parse(readFileSync(path.join(runDir, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'failed');
  assert.equal(summary.stages.length, 2); // deploy не выполнялся
});

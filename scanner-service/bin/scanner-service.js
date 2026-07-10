#!/usr/bin/env node
import process from 'node:process';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { TaskScanner } from '../src/TaskScanner.js';
import { TaskIntake } from '../src/TaskIntake.js';
import { ScannerSupervisor } from '../src/ScannerSupervisor.js';
import {
  createApiStageConfigProvider,
  createSnapshotStageConfigProvider,
} from '../src/StageConfigProvider.js';
import { createHttpDispatch } from '../src/httpDispatch.js';
import { resolveScannerRuntime, ScannerModeError } from '../src/runtimeConfig.js';

// --- Конфигурация ----------------------------------------------------------
const once = process.argv.includes('--once');
const token = process.env.ORCHESTRATOR_API_TOKEN || '';
const debounceMs = Number(process.env.SCANNER_DEBOUNCE_MS || 150);
const fallbackMs = Number(process.env.SCANNER_FALLBACK_MS ?? 5000);
const clearOnDispatch = process.env.SCANNER_CLEAR_ON_DISPATCH !== 'false';

let runtime;
try {
  runtime = resolveScannerRuntime(process.env);
} catch (error) {
  if (error instanceof ScannerModeError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
const { mode, apiBase, orchestratorBase } = runtime;
const snapshotPath = mode === 'snapshot' ? resolve(process.env.SCANNER_SNAPSHOT) : null;
const taskCompletedEndpoint = `${orchestratorBase}/api/scanner/task-completed`;

/** Имя state-файла на watcher: изолирует exactly-once state по projectId+stageId. */
function stateFileFor(config, stateDir) {
  const safe = `${config.projectId}__${config.stageId}`.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(stateDir, `${safe}.json`);
}

// --- API / snapshot мульти-watcher режим -----------------------------------
function buildSupervisor() {
  const stateDir = resolve(process.env.SCANNER_STATE_DIR || 'runtime/scanner-state');
  const intervalMs = Number(process.env.SCANNER_CONFIG_INTERVAL_MS || 5000);

  const provider = apiBase
    ? createApiStageConfigProvider({ projectsEndpoint: `${apiBase}/api/projects`, token })
    : createSnapshotStageConfigProvider({ snapshotPath });

  const buildScanner = (config) =>
    new TaskScanner({
      watchDirectory: config.watchDirectory,
      documentName: config.documentName,
      statePath: stateFileFor(config, stateDir),
      projectId: config.projectId,
      stageId: config.stageId,
      debounceMs,
      fallbackMs,
      clearOnDispatch,
      dispatch: createHttpDispatch({ endpoint: taskCompletedEndpoint, token }),
    });

  return new ScannerSupervisor({ provider, buildScanner, intervalMs });
}

// --- Интейк Markdown-очередей (SCANNER-INTAKE-001) --------------------------
// Не связан с режимом watcher: импортирует задачи из tasks/<service>.md (секции
// с маркером `[x]`) в БД оркестратора. Включается заданием проекта-владельца.
function buildIntake() {
  const project = String(process.env.SCANNER_INTAKE_PROJECT ?? '').trim();
  if (!project) return null;
  const tasksDir = resolve(process.env.SCANNER_INTAKE_DIR || 'tasks');
  return new TaskIntake({
    tasksDir,
    project,
    intake: createHttpDispatch({ endpoint: `${orchestratorBase}/api/scanner/task-intake`, token }),
  });
}

// --- Health/readiness HTTP -------------------------------------------------
function startHealthServer(readiness) {
  const port = Number(process.env.SCANNER_HEALTH_PORT || 0);
  if (!port) return null;
  const server = createServer((req, res) => {
    if (req.url === '/health' || req.url === '/readiness') {
      const body = readiness();
      const code = body.status === 'ok' ? 200 : 503;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => console.log(`Scanner health on :${port}`));
  server.unref?.();
  return server;
}

// --- Запуск ----------------------------------------------------------------
const supervisor = buildSupervisor();
const intake = buildIntake();

if (once) {
  const summary = await supervisor.refresh();
  const intakeResult = intake ? await intake.scanOnce() : null;
  console.log(JSON.stringify({ mode, summary, intake: intakeResult, readiness: supervisor.readiness() }));
  supervisor.stop();
} else {
  console.log(`Scanner (${mode} multi-watcher) reconciling from orchestrator config`);
  await supervisor.start();
  let intakeTimer = null;
  if (intake) {
    const intakeIntervalMs = Number(process.env.SCANNER_INTAKE_INTERVAL_MS || 5000);
    console.log(`Intake scans ${intake.tasksDir} (project ${intake.project}) every ${intakeIntervalMs}ms`);
    const intakeTick = () => intake.scanOnce().catch((e) => console.error(`Intake failed: ${e.message}`));
    void intakeTick();
    intakeTimer = setInterval(intakeTick, intakeIntervalMs);
    intakeTimer.unref?.();
  }
  startHealthServer(() => ({
    mode,
    ...supervisor.readiness(),
    intake: intake ? { tasksDir: intake.tasksDir, project: intake.project } : null,
  }));
  // Health-сервер и intake-таймер заunref'лены, а watcher'ов может не быть
  // (например, стартовый refresh не достучался до оркестратора — `fetch failed`).
  // Без единственного ref'd хэндла событийный цикл пустеет и Node завершается
  // с кодом 13 (unsettled top-level await ниже). Этот таймер держит процесс живым.
  const keepAlive = setInterval(() => {}, 3600_000);
  const stop = () => {
    supervisor.stop();
    if (intakeTimer) clearInterval(intakeTimer);
    clearInterval(keepAlive);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
}

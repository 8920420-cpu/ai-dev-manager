#!/usr/bin/env node
import process from 'node:process';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { TaskScanner } from '../src/TaskScanner.js';
import { TaskFeeder } from '../src/TaskFeeder.js';
import { ScannerSupervisor } from '../src/ScannerSupervisor.js';
import {
  createApiStageConfigProvider,
  createSnapshotStageConfigProvider,
} from '../src/StageConfigProvider.js';
import { createHttpDispatch } from '../src/httpDispatch.js';
import { createHttpFeed } from '../src/httpFeed.js';

// --- Конфигурация ----------------------------------------------------------
const once = process.argv.includes('--once');
const token = process.env.ORCHESTRATOR_API_TOKEN || '';
const debounceMs = Number(process.env.SCANNER_DEBOUNCE_MS || 150);
const fallbackMs = Number(process.env.SCANNER_FALLBACK_MS ?? 5000);
const clearOnDispatch = process.env.SCANNER_CLEAR_ON_DISPATCH !== 'false';

// Базовый URL оркестратора для API-режима. Из него выводятся все endpoints.
const apiBase = (process.env.SCANNER_API_BASE || process.env.ORCHESTRATOR_API_BASE || '').replace(/\/+$/, '');
const snapshotPath = process.env.SCANNER_SNAPSHOT ? resolve(process.env.SCANNER_SNAPSHOT) : null;

// Приоритет режимов: API (по этапам проектов) > snapshot > legacy single-watcher.
// API-конфигурация ВСЕГДА имеет приоритет над SCANNER_DOCUMENT: при одновременной
// установке legacy env игнорируется (с явным сообщением), чтобы не было двух
// конфликтующих источников истины для одной папки.
const mode = apiBase ? 'api' : snapshotPath ? 'snapshot' : 'legacy';

/** Имя state-файла на watcher: изолирует exactly-once state по projectId+stageId. */
function stateFileFor(config, stateDir) {
  const safe = `${config.projectId}__${config.stageId}`.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(stateDir, `${safe}.json`);
}

// --- API / snapshot мульти-watcher режим -----------------------------------
function buildSupervisor() {
  const endpoint = `${apiBase || (process.env.SCANNER_ENDPOINT || '').replace(/\/api\/scanner\/task-completed$/, '')}/api/scanner/task-completed`;
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
      dispatch: createHttpDispatch({ endpoint, token }),
    });

  return new ScannerSupervisor({ provider, buildScanner, intervalMs });
}

// --- Legacy одиночный watcher + обратный мост (fallback) -------------------
function buildLegacy() {
  const documentPath = resolve(process.env.SCANNER_DOCUMENT || 'runtime/claude-tasks.json');
  const statePath = resolve(process.env.SCANNER_STATE || 'runtime/.scanner-state.json');
  const endpoint = process.env.SCANNER_ENDPOINT || 'http://localhost:4186/api/scanner/task-completed';
  const base = endpoint.replace(/\/api\/scanner\/task-completed$/, '');
  const nextEndpoint = process.env.FEEDER_NEXT_ENDPOINT || `${base}/api/runner/next-claude-task`;
  const releaseEndpoint = process.env.FEEDER_RELEASE_ENDPOINT || `${base}/api/runner/release-claude-task`;
  const feederEnabled = process.env.FEEDER_ENABLED !== 'false';
  const feederIntervalMs = Number(process.env.FEEDER_INTERVAL_MS || 3000);

  const scanner = new TaskScanner({
    documentPath,
    statePath,
    debounceMs,
    fallbackMs,
    clearOnDispatch,
    dispatch: createHttpDispatch({ endpoint, token }),
  });
  const feeder = feederEnabled
    ? new TaskFeeder({ documentPath, ...createHttpFeed({ nextEndpoint, releaseEndpoint, token }) })
    : null;
  return { documentPath, scanner, feeder, nextEndpoint, feederIntervalMs };
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
if (apiBase && process.env.SCANNER_DOCUMENT) {
  console.warn('SCANNER_DOCUMENT ignored: API config (SCANNER_API_BASE) takes precedence');
}

if (mode === 'legacy') {
  const { documentPath, scanner, feeder, nextEndpoint, feederIntervalMs } = buildLegacy();
  if (once) {
    const scan = await scanner.scanOnce();
    const feed = feeder ? await feeder.feedOnce() : null;
    console.log(JSON.stringify({ scan, feed }));
  } else {
    console.log(`Scanner (legacy single watcher) watches ${documentPath}`);
    scanner.start();
    let feederTimer = null;
    if (feeder) {
      console.log(`Feeder polls ${nextEndpoint} every ${feederIntervalMs}ms`);
      const feedTick = () => feeder.feedOnce().catch((e) => console.error(`Feeder failed: ${e.message}`));
      void feedTick();
      feederTimer = setInterval(feedTick, feederIntervalMs);
      feederTimer.unref?.();
    }
    startHealthServer(() => ({ status: 'ok', mode: 'legacy', watcher: { documentPath } }));
    const stop = () => {
      scanner.stop();
      if (feederTimer) clearInterval(feederTimer);
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    await new Promise(() => {});
  }
} else {
  const supervisor = buildSupervisor();
  if (once) {
    const summary = await supervisor.refresh();
    console.log(JSON.stringify({ mode, summary, readiness: supervisor.readiness() }));
    supervisor.stop();
  } else {
    console.log(`Scanner (${mode} multi-watcher) reconciling from orchestrator config`);
    await supervisor.start();
    startHealthServer(() => ({ mode, ...supervisor.readiness() }));
    const stop = () => {
      supervisor.stop();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    await new Promise(() => {});
  }
}

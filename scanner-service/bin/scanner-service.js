#!/usr/bin/env node
import process from 'node:process';
import { resolve } from 'node:path';
import { TaskScanner } from '../src/TaskScanner.js';
import { TaskFeeder } from '../src/TaskFeeder.js';
import { createHttpDispatch } from '../src/httpDispatch.js';
import { createHttpFeed } from '../src/httpFeed.js';

const once = process.argv.includes('--once');
const documentPath = resolve(process.env.SCANNER_DOCUMENT || 'runtime/claude-tasks.json');
const statePath = resolve(process.env.SCANNER_STATE || 'runtime/.scanner-state.json');
const endpoint = process.env.SCANNER_ENDPOINT || 'http://localhost:4186/api/scanner/task-completed';
// Обратный мост (Stage 2). По умолчанию выводим из SCANNER_ENDPOINT, заменяя путь.
const apiBase = endpoint.replace(/\/api\/scanner\/task-completed$/, '');
const nextEndpoint = process.env.FEEDER_NEXT_ENDPOINT || `${apiBase}/api/runner/next-claude-task`;
const releaseEndpoint = process.env.FEEDER_RELEASE_ENDPOINT || `${apiBase}/api/runner/release-claude-task`;
const feederEnabled = process.env.FEEDER_ENABLED !== 'false';
const feederIntervalMs = Number(process.env.FEEDER_INTERVAL_MS || 3000);
const token = process.env.ORCHESTRATOR_API_TOKEN || '';

const scanner = new TaskScanner({
  documentPath,
  statePath,
  debounceMs: Number(process.env.SCANNER_DEBOUNCE_MS || 150),
  fallbackMs: Number(process.env.SCANNER_FALLBACK_MS ?? 5000),
  clearOnDispatch: process.env.SCANNER_CLEAR_ON_DISPATCH !== 'false',
  dispatch: createHttpDispatch({ endpoint, token }),
});

const feeder = feederEnabled
  ? new TaskFeeder({
      documentPath,
      ...createHttpFeed({ nextEndpoint, releaseEndpoint, token }),
    })
  : null;

if (once) {
  const scan = await scanner.scanOnce();
  const feed = feeder ? await feeder.feedOnce() : null;
  console.log(JSON.stringify({ scan, feed }));
} else {
  console.log(`Scanner watches ${documentPath}`);
  scanner.start();

  let feederTimer = null;
  if (feeder) {
    console.log(`Feeder polls ${nextEndpoint} every ${feederIntervalMs}ms`);
    const feedTick = () =>
      feeder.feedOnce().catch((e) => console.error(`Feeder failed: ${e.message}`));
    void feedTick();
    feederTimer = setInterval(feedTick, feederIntervalMs);
    feederTimer.unref?.();
  }

  const stop = () => {
    scanner.stop();
    if (feederTimer) clearInterval(feederTimer);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
}

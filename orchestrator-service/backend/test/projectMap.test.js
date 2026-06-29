import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectMaps, _clearProjectMapCache } from '../src/projectMap.js';

test('loadProjectMaps: пустой корень → null', async () => {
  _clearProjectMapCache();
  assert.equal(await loadProjectMaps(''), null);
});

test('loadProjectMaps: читает карту проекта (docs/PROJECT_MAP.md) и карту сервиса', async () => {
  _clearProjectMapCache();
  const root = await mkdtemp(join(tmpdir(), 'pmap-'));
  try {
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'PROJECT_MAP.md'), '# Общая карта');
    await writeFile(join(root, 'docs', 'ARCHITECTURE.md'), '# Архитектура');
    await mkdir(join(root, 'scanner-service', 'docs'), { recursive: true });
    await writeFile(join(root, 'scanner-service', 'docs', 'PROJECT_MAP.md'), '# Карта scanner');

    const maps = await loadProjectMaps(root, { service: 'scanner-service' });
    assert.ok(maps);
    assert.match(maps.project, /Общая карта/);
    assert.match(maps.project, /Архитектура/);
    assert.match(maps.service, /Карта scanner/);
    assert.equal(maps.serviceName, 'scanner-service');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadProjectMaps: нет ни одной карты → null', async () => {
  _clearProjectMapCache();
  const root = await mkdtemp(join(tmpdir(), 'pmap-empty-'));
  try {
    const maps = await loadProjectMaps(root, { service: 'x' });
    assert.equal(maps, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadProjectMaps: усечение карты по бюджету символов', async () => {
  _clearProjectMapCache();
  const prev = process.env.PROJECT_MAP_MAX_CHARS;
  process.env.PROJECT_MAP_MAX_CHARS = '100';
  // Модуль читает env при загрузке — переимпортируем со свежим лимитом.
  const mod = await import(`../src/projectMap.js?clip=${Date.now()}`);
  const root = await mkdtemp(join(tmpdir(), 'pmap-clip-'));
  try {
    await writeFile(join(root, 'PROJECT_MAP.md'), 'x'.repeat(5000));
    const maps = await mod.loadProjectMaps(root, {});
    assert.ok(maps.project.length < 5000);
    assert.match(maps.project, /карта усечена/);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.PROJECT_MAP_MAX_CHARS;
    else process.env.PROJECT_MAP_MAX_CHARS = prev;
  }
});

test('loadProjectMaps: кэш отдаёт прежнее значение в пределах TTL (now)', async () => {
  _clearProjectMapCache();
  const root = await mkdtemp(join(tmpdir(), 'pmap-cache-'));
  try {
    await writeFile(join(root, 'PROJECT_MAP.md'), 'V1');
    const first = await loadProjectMaps(root, { now: 1000 });
    assert.match(first.project, /V1/);
    // Файл изменился, но в пределах TTL (тот же now) отдаём из кэша.
    await writeFile(join(root, 'PROJECT_MAP.md'), 'V2');
    const cached = await loadProjectMaps(root, { now: 1000 });
    assert.match(cached.project, /V1/);
    // За пределами TTL (большой скачок now) — перечитываем.
    const fresh = await loadProjectMaps(root, { now: 1000 + 60 * 60 * 1000 + 1 });
    assert.match(fresh.project, /V2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

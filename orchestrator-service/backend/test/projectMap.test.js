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

// RESEARCH-BUDGET-002: авто-индекс структуры репозитория (каталог сервисов для
// монорепо) дописывается к проектной карте в ПОЛНОМ варианте.
test('loadProjectMaps: авто-индекс каталогов верхнего уровня в full', async () => {
  _clearProjectMapCache();
  const root = await mkdtemp(join(tmpdir(), 'pmap-outline-'));
  try {
    await writeFile(join(root, 'PROJECT_MAP.md'), '# Проект');
    await mkdir(join(root, 'Auth'), { recursive: true });
    await mkdir(join(root, 'CRM'), { recursive: true });
    await mkdir(join(root, 'node_modules'), { recursive: true }); // шум — не в индексе
    const maps = await loadProjectMaps(root, {});
    assert.match(maps.project, /Проект/);              // карта-док осталась
    assert.match(maps.project, /структура репозитория/);
    assert.match(maps.project, /Auth/);
    assert.match(maps.project, /CRM/);
    assert.doesNotMatch(maps.project, /node_modules/);  // шумовые папки исключены
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// В short-варианте (codex, без prompt-кэша) индекс НЕ добавляем — экономим символы.
test('loadProjectMaps: авто-индекс НЕ добавляется в short', async () => {
  _clearProjectMapCache();
  const root = await mkdtemp(join(tmpdir(), 'pmap-outline-short-'));
  try {
    await writeFile(join(root, 'PROJECT_MAP.md'), '# Проект');
    await mkdir(join(root, 'Auth'), { recursive: true });
    const short = await loadProjectMaps(root, { variant: 'short' });
    assert.match(short.project, /Проект/);
    assert.doesNotMatch(short.project, /структура репозитория/);
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

// PROMPT-CACHE-001: сокращённый вариант карты для движков без prompt-кэша (codex).
test('loadProjectMaps: variant=short приоритетно отдаёт карту сервиса (проектную опускает)', async () => {
  _clearProjectMapCache();
  const root = await mkdtemp(join(tmpdir(), 'pmap-short-'));
  try {
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'PROJECT_MAP.md'), '# Общая карта');
    await mkdir(join(root, 'scanner-service', 'docs'), { recursive: true });
    await writeFile(join(root, 'scanner-service', 'docs', 'PROJECT_MAP.md'), '# Карта scanner');

    const short = await loadProjectMaps(root, { service: 'scanner-service', variant: 'short' });
    assert.equal(short.project, ''); // проектную карту капнули до сервис-карты
    assert.match(short.service, /Карта scanner/);
    // Полный вариант отдаёт обе карты.
    const full = await loadProjectMaps(root, { service: 'scanner-service', variant: 'full' });
    assert.match(full.project, /Общая карта/);
    assert.match(full.service, /Карта scanner/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadProjectMaps: variant=short без сервис-карты оставляет короткую карту проекта', async () => {
  _clearProjectMapCache();
  const root = await mkdtemp(join(tmpdir(), 'pmap-short2-'));
  try {
    await writeFile(join(root, 'PROJECT_MAP.md'), '# Только проект');
    const short = await loadProjectMaps(root, { service: '', variant: 'short' });
    assert.match(short.project, /Только проект/);
    assert.equal(short.service, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadProjectMaps: variant в ключе кэша — short и full не затирают друг друга', async () => {
  _clearProjectMapCache();
  const root = await mkdtemp(join(tmpdir(), 'pmap-vk-'));
  try {
    await mkdir(join(root, 'svc', 'docs'), { recursive: true });
    await writeFile(join(root, 'PROJECT_MAP.md'), '# Проект');
    await writeFile(join(root, 'svc', 'docs', 'PROJECT_MAP.md'), '# Сервис');
    const full = await loadProjectMaps(root, { service: 'svc', variant: 'full', now: 5000 });
    const short = await loadProjectMaps(root, { service: 'svc', variant: 'short', now: 5000 });
    assert.match(full.project, /Проект/);      // полный вариант из своего ключа
    assert.equal(short.project, '');            // short не подхватил full из кэша
  } finally {
    await rm(root, { recursive: true, force: true });
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

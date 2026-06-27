import { test } from 'node:test';
import assert from 'node:assert/strict';

// PROJECT-PATH-MAP-001: mapRootToContainer читает TOOLS_PROJECT_PATH_MAP при
// импорте модуля, поэтому переменную выставляем ДО import и грузим модуль свежим.
process.env.TOOLS_PROJECT_PATH_MAP = 'K:\\Роботы\\Golang\\git=>/projects';
const { mapRootToContainer } = await import('../src/toolsClient.js');

test('Windows root_path под префиксом → контейнерный путь', () => {
  assert.equal(mapRootToContainer('K:\\Роботы\\Golang\\git\\PS'), '/projects/PS');
  assert.equal(
    mapRootToContainer('K:\\Роботы\\Golang\\git\\ai-dev-manager'),
    '/projects/ai-dev-manager',
  );
});

test('подкаталог проекта тоже транслируется', () => {
  assert.equal(
    mapRootToContainer('K:\\Роботы\\Golang\\git\\PS\\catalog-service'),
    '/projects/PS/catalog-service',
  );
});

test('сравнение префикса регистронезависимо и не зависит от вида слешей', () => {
  assert.equal(mapRootToContainer('k:/Роботы/Golang/git/PS'), '/projects/PS');
});

test('путь вне префикса остаётся как есть', () => {
  assert.equal(mapRootToContainer('D:\\other\\repo'), 'D:\\other\\repo');
});

test('пустой/недопустимый вход не падает', () => {
  assert.equal(mapRootToContainer(''), '');
  assert.equal(mapRootToContainer(null), null);
});

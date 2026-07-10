import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRootPath, basename, slugifyCode } from '../src/projects.js';

test('normalizeRootPath: трим и срез хвостового слеша; пусто → null', () => {
  assert.equal(normalizeRootPath('  K:\\projects\\app\\  '), 'K:\\projects\\app');
  assert.equal(normalizeRootPath('/home/user/app/'), '/home/user/app');
  assert.equal(normalizeRootPath('/home/user/app'), '/home/user/app');
  assert.equal(normalizeRootPath('   '), null);
  assert.equal(normalizeRootPath(undefined), null);
});

test('basename: последняя часть пути для Windows и POSIX', () => {
  assert.equal(basename('K:\\projects\\catalog-service'), 'catalog-service');
  assert.equal(basename('/home/user/chat'), 'chat');
  assert.equal(basename('/home/user/chat/'), 'chat');
  assert.equal(basename(''), '');
});

test('slugifyCode: A-Z0-9_, без пустот, дефолт PROJECT', () => {
  assert.equal(slugifyCode('Catalog Service'), 'CATALOG_SERVICE');
  assert.equal(slugifyCode('ps-torg'), 'PS_TORG');
  assert.equal(slugifyCode('  --- '), 'PROJECT');
  assert.equal(slugifyCode('Чат'), 'PROJECT'); // не-латиница отбрасывается
  assert.equal(slugifyCode('a'.repeat(60)).length, 40);
});

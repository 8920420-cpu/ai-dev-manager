import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  safeResolve,
  readFileTool,
  listDirTool,
  searchTextTool,
  editFileTool,
  writeFileTool,
  deleteFileTool,
  executeBuiltin,
  parseAllowedRoots,
  isRootAllowed,
} from '../src/builtins.js';
import { readFile as fsRead, access } from 'node:fs/promises';
import { buildMcpConfig, toMcpServer } from '../src/mcp.js';
import { handleRoute } from '../src/server.js';

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), 'tools-'));
  await writeFile(join(root, 'README.md'), '# Проект\nстрока с TARGET внутри\n', 'utf8');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'index.js'), 'export const x = 1; // TARGET\n', 'utf8');
  return root;
}

test('safeResolve: блокирует выход за пределы root', () => {
  const root = '/srv/project';
  assert.ok(safeResolve(root, 'src/a.js'));
  assert.equal(safeResolve(root, '../etc/passwd'), null);
  assert.equal(safeResolve(root, '/etc/passwd'), null);
});

test('read_file: читает файл внутри root', async (t) => {
  const root = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const res = await readFileTool({ root, path: 'README.md' });
  assert.match(res.content, /Проект/);
  assert.equal(res.truncated, false);
});

test('read_file: путь за пределами root → ошибка', async (t) => {
  const root = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => readFileTool({ root, path: '../secret' }), (e) => e.code === 'path_outside_root');
});

test('read_file: без root → ошибка', async () => {
  await assert.rejects(() => readFileTool({ path: 'README.md' }), (e) => e.code === 'root_required');
});

test('list_dir: каталоги первыми, скрытые пропущены', async (t) => {
  const root = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const res = await listDirTool({ root, path: '.' });
  assert.equal(res.entries[0].type, 'dir');
  assert.ok(res.entries.some((e) => e.name === 'README.md' && e.type === 'file'));
});

test('search_text: находит подстроку с указанием файла и строки', async (t) => {
  const root = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const res = await searchTextTool({ root, query: 'TARGET' });
  assert.equal(res.matches.length, 2);
  assert.ok(res.matches.some((m) => m.file === 'src/index.js'));
});

test('executeBuiltin: неизвестный инструмент → ошибка unknown_tool', async () => {
  await assert.rejects(() => executeBuiltin('nope', {}), (e) => e.code === 'unknown_tool');
});

test('write_file: создаёт файл (с каталогами)', async (t) => {
  const root = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const res = await writeFileTool({ root, path: 'src/new/a.txt', content: 'привет' });
  assert.equal(res.written, true);
  assert.equal(await fsRead(join(root, 'src/new/a.txt'), 'utf8'), 'привет');
});

test('edit_file: заменяет уникальный фрагмент', async (t) => {
  const root = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const res = await editFileTool({ root, path: 'src/index.js', oldText: 'const x = 1', newText: 'const x = 2' });
  assert.equal(res.edited, true);
  assert.match(await fsRead(join(root, 'src/index.js'), 'utf8'), /const x = 2/);
});

test('edit_file: фрагмент не найден → ошибка', async (t) => {
  const root = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => editFileTool({ root, path: 'src/index.js', oldText: 'НЕТ', newText: 'x' }), (e) => e.code === 'old_text_not_found');
});

test('delete_file: удаляет файл', async (t) => {
  const root = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const res = await deleteFileTool({ root, path: 'README.md' });
  assert.equal(res.deleted, true);
  await assert.rejects(() => access(join(root, 'README.md')));
});

test('write_file: путь за пределами root → ошибка', async (t) => {
  const root = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => writeFileTool({ root, path: '../evil.txt', content: 'x' }), (e) => e.code === 'path_outside_root');
});

test('buildMcpConfig: stdio и http записи, пропуск невалидных', () => {
  const cfg = buildMcpConfig([
    { name: 'fs', config: { command: 'npx', args: ['-y', 'mcp-fs'], env: { ROOT: '/p' } } },
    { name: 'web', config: { url: 'https://example.com/mcp' } },
    { name: '', config: { command: 'x' } }, // без имени → пропуск
    { name: 'bad', config: {} }, // ни command, ни url → пропуск
  ]);
  assert.deepEqual(cfg.mcpServers.fs, { command: 'npx', args: ['-y', 'mcp-fs'], env: { ROOT: '/p' } });
  assert.deepEqual(cfg.mcpServers.web, { url: 'https://example.com/mcp' });
  assert.equal(cfg.mcpServers.bad, undefined);
  assert.equal(Object.keys(cfg.mcpServers).length, 2);
});

test('toMcpServer: пустой конфиг → null', () => {
  assert.equal(toMcpServer({}), null);
});

test('handleRoute: /health ok', async () => {
  const r = await handleRoute('GET', '/health', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
});

test('handleRoute: /execute read_file', async (t) => {
  const root = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const r = await handleRoute('POST', '/execute', { tool: 'read_file', args: { root, path: 'README.md' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.body.result.content, /Проект/);
});

test('handleRoute: /execute неизвестный инструмент → 404', async () => {
  const r = await handleRoute('POST', '/execute', { tool: 'nope', args: {} });
  assert.equal(r.status, 404);
  assert.equal(r.body.ok, false);
});

test('handleRoute: /mcp-config собирает mcpServers', async () => {
  const r = await handleRoute('POST', '/mcp-config', { tools: [{ name: 'fs', config: { command: 'x' } }] });
  assert.equal(r.status, 200);
  assert.ok(r.body.mcpServers.fs);
});

test('parseAllowedRoots: разбирает PATH-список и запятые в абсолютные пути', () => {
  const roots = parseAllowedRoots('/projects:/app/ai-dev-manager, /srv/other');
  assert.deepEqual(roots, ['/projects', '/app/ai-dev-manager', '/srv/other'].map((p) => resolve(p)));
  assert.deepEqual(parseAllowedRoots(''), []);
  assert.deepEqual(parseAllowedRoots(undefined), []);
});

test('isRootAllowed: пустой allowlist пропускает любой root', () => {
  assert.equal(isRootAllowed('/anything', []), true);
  assert.equal(isRootAllowed('/anything', undefined), true);
});

test('isRootAllowed: вне разрешённых корней → false, внутри → true', () => {
  const allowed = parseAllowedRoots('/projects:/app/ai-dev-manager');
  assert.equal(isRootAllowed('/projects', allowed), true);
  assert.equal(isRootAllowed('/projects/ps', allowed), true);
  assert.equal(isRootAllowed('/app/ai-dev-manager/src', allowed), true);
  assert.equal(isRootAllowed('/etc', allowed), false);
  assert.equal(isRootAllowed('/projects-evil', allowed), false); // префикс без разделителя
});

test('handleRoute: /execute с root вне allowlist → 403 root_not_allowed', async (t) => {
  const root = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const r = await handleRoute(
    'POST',
    '/execute',
    { tool: 'read_file', args: { root, path: 'README.md' } },
    { allowedRoots: parseAllowedRoots('/projects') },
  );
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'root_not_allowed');
});

test('handleRoute: /execute с root внутри allowlist → 200', async (t) => {
  const root = await makeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const r = await handleRoute(
    'POST',
    '/execute',
    { tool: 'read_file', args: { root, path: 'README.md' } },
    { allowedRoots: [resolve(root)] },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

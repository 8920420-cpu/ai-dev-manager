import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveDocumentPath,
  requireWatchDirectory,
  checkWatchDirectory,
  isAbsolutePathSyntax,
  ScannerConfigError,
  SCANNER_READY_CODE,
} from '../src/paths.js';

test('requireWatchDirectory отклоняет пустой и относительный путь', () => {
  assert.throws(() => requireWatchDirectory(''), (e) => e.code === SCANNER_READY_CODE.WATCH_DIR_REQUIRED);
  assert.throws(() => requireWatchDirectory('   '), (e) => e.code === SCANNER_READY_CODE.WATCH_DIR_REQUIRED);
  assert.throws(() => requireWatchDirectory('relative/dir'), (e) => e.code === SCANNER_READY_CODE.WATCH_DIR_ABSOLUTE);
});

test('isAbsolutePathSyntax признаёт Windows/UNC/POSIX', () => {
  assert.ok(isAbsolutePathSyntax('K:\\projects\\svc'));
  assert.ok(isAbsolutePathSyntax('C:/x'));
  assert.ok(isAbsolutePathSyntax('\\\\host\\share'));
  assert.ok(isAbsolutePathSyntax('/home/user'));
  assert.ok(!isAbsolutePathSyntax('tasks'));
  assert.ok(!isAbsolutePathSyntax('./tasks'));
});

test('resolveDocumentPath кладёт документ внутрь watchDirectory', () => {
  const abs = process.platform === 'win32' ? 'C:\\watch\\dir' : '/watch/dir';
  const { watchDirectory, documentPath } = resolveDocumentPath(abs, 'claude-tasks.json');
  assert.ok(documentPath.startsWith(watchDirectory));
  assert.ok(documentPath.endsWith('claude-tasks.json'));
});

test('resolveDocumentPath default — claude-tasks.json', () => {
  const abs = process.platform === 'win32' ? 'C:\\watch\\dir' : '/watch/dir';
  const { documentPath } = resolveDocumentPath(abs);
  assert.ok(documentPath.endsWith('claude-tasks.json'));
});

test('resolveDocumentPath отклоняет выход за каталог через ..', () => {
  const abs = process.platform === 'win32' ? 'C:\\watch\\dir' : '/watch/dir';
  assert.throws(
    () => resolveDocumentPath(abs, '../escape.json'),
    (e) => e instanceof ScannerConfigError && e.code === SCANNER_READY_CODE.DOCUMENT_PATH_ESCAPE,
  );
});

test('resolveDocumentPath отклоняет абсолютное имя документа', () => {
  const abs = process.platform === 'win32' ? 'C:\\watch\\dir' : '/watch/dir';
  const absDoc = process.platform === 'win32' ? 'C:\\other\\x.json' : '/other/x.json';
  assert.throws(
    () => resolveDocumentPath(abs, absDoc),
    (e) => e.code === SCANNER_READY_CODE.DOCUMENT_PATH_ESCAPE,
  );
});

test('resolveDocumentPath отклоняет пустое имя документа', () => {
  const abs = process.platform === 'win32' ? 'C:\\watch\\dir' : '/watch/dir';
  assert.throws(() => resolveDocumentPath(abs, '   '), (e) => e.code === SCANNER_READY_CODE.DOCUMENT_NAME_REQUIRED);
});

test('checkWatchDirectory: ok для существующего каталога', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'scan-ok-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { documentPath } = resolveDocumentPath(dir, 'claude-tasks.json');
  assert.deepEqual(await checkWatchDirectory(dir, documentPath), { ok: true });
});

test('checkWatchDirectory: отсутствующий каталог → unavailable', async () => {
  const missing = join(tmpdir(), 'scan-missing-xyz-123', 'sub');
  const res = await checkWatchDirectory(missing, join(missing, 'claude-tasks.json'));
  assert.equal(res.ok, false);
  assert.equal(res.code, SCANNER_READY_CODE.WATCH_DIR_UNAVAILABLE);
});

test('checkWatchDirectory: путь к файлу (не каталог) → unavailable', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'scan-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { writeFile } = await import('node:fs/promises');
  const filePath = join(dir, 'not-a-dir');
  await writeFile(filePath, 'x', 'utf8');
  const res = await checkWatchDirectory(filePath, join(filePath, 'claude-tasks.json'));
  assert.equal(res.ok, false);
  assert.equal(res.code, SCANNER_READY_CODE.WATCH_DIR_UNAVAILABLE);
});

test('checkWatchDirectory: symlink-каталог внутри допустим (реальный путь совпадает)', async (t) => {
  if (process.platform === 'win32') return; // symlink на Windows требует прав
  const dir = await mkdtemp(join(tmpdir(), 'scan-sym-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const real = join(dir, 'real');
  const link = join(dir, 'link');
  await mkdir(real);
  await symlink(real, link);
  // Наблюдаем через симлинк, документ внутри него: реальный путь = real → ok.
  const { documentPath } = resolveDocumentPath(link, 'claude-tasks.json');
  assert.deepEqual(await checkWatchDirectory(link, documentPath), { ok: true });
});

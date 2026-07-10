import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeMemoryInput, readMemoryFiles } from '../src/codebaseMemory.js';

test('normalizeMemoryInput: validates known keys and fills defaults', () => {
  const doc = normalizeMemoryInput({ key: 'stack', content: '# Stack' });
  assert.equal(doc.key, 'stack');
  assert.equal(doc.title, 'Tech Stack');
  assert.equal(doc.filePath, '.claude/rules/stack.md');
  assert.match(doc.checksum, /^[a-f0-9]{64}$/);
});

test('normalizeMemoryInput: rejects unknown keys and empty content', () => {
  assert.throws(() => normalizeMemoryInput({ key: 'bad', content: 'x' }), /memory_key_invalid/);
  assert.throws(() => normalizeMemoryInput({ key: 'stack', content: '   ' }), /memory_content_required/);
});

test('readMemoryFiles: reads generated codebase-memory files from project root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cbm-'));
  await mkdir(join(root, '.claude', 'rules'), { recursive: true });
  await writeFile(join(root, 'CLAUDE.md'), '# Claude');
  await writeFile(join(root, '.claude', 'rules', 'stack.md'), '# Stack');
  await writeFile(join(root, 'CONVENTIONS.md'), '# Conventions');

  const docs = await readMemoryFiles(root);
  assert.deepEqual(docs.map((d) => d.key).sort(), ['claude', 'conventions_doc', 'stack']);
  assert.equal(docs.find((d) => d.key === 'stack').filePath, '.claude/rules/stack.md');
});

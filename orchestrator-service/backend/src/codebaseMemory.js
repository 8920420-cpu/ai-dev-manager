import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { withClient, clientConfig } from './db.js';

export const MEMORY_DOCUMENTS = [
  { key: 'claude', title: 'Claude Memory Index', path: 'CLAUDE.md' },
  { key: 'architecture', title: 'Architecture', path: '.claude/rules/architecture.md' },
  { key: 'stack', title: 'Tech Stack', path: '.claude/rules/stack.md' },
  { key: 'modules', title: 'Module Map', path: '.claude/rules/modules.md' },
  { key: 'models', title: 'Data Models', path: '.claude/rules/models.md' },
  { key: 'api', title: 'API Surface', path: '.claude/rules/api.md' },
  { key: 'conventions', title: 'Conventions', path: '.claude/rules/conventions.md' },
  { key: 'gotchas', title: 'Gotchas', path: '.claude/rules/gotchas.md' },
  { key: 'changelog', title: 'Memory Changelog', path: '.claude/rules/changelog.md' },
  { key: 'conventions_doc', title: 'Conventions Document', path: 'CONVENTIONS.md' },
];

const MEMORY_KEY_SET = new Set(MEMORY_DOCUMENTS.map((d) => d.key));

function httpError(statusCode, message, extra) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (extra) Object.assign(error, extra);
  return error;
}

function checksum(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function toIso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function mapDocument(row, { includeContent = true } = {}) {
  const out = {
    id: row.id,
    projectId: row.project_id,
    key: row.doc_key,
    title: row.title,
    filePath: row.file_path,
    checksum: row.checksum,
    metadata: row.metadata ?? {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
  if (includeContent) out.content = row.content ?? '';
  return out;
}

async function resolveProjectRow(c, ref) {
  const value = String(ref ?? '').trim();
  if (!value) throw httpError(422, 'project_required', { code: 'project_required' });
  const r = await c.query(
    `SELECT id, code, name, root_path
       FROM projects
      WHERE id::text = $1 OR code = $1 OR root_path = $1 OR name = $1
      ORDER BY created_at
      LIMIT 1`,
    [value],
  );
  if (!r.rowCount) throw httpError(404, 'project_not_found', { code: 'project_not_found' });
  return r.rows[0];
}

export function normalizeMemoryInput(input) {
  const key = String(input?.key ?? input?.docKey ?? '').trim();
  if (!MEMORY_KEY_SET.has(key)) throw httpError(422, 'memory_key_invalid', { code: 'memory_key_invalid' });
  const spec = MEMORY_DOCUMENTS.find((d) => d.key === key);
  const content = String(input?.content ?? '');
  if (!content.trim()) throw httpError(422, 'memory_content_required', { code: 'memory_content_required' });
  const title = String(input?.title ?? spec.title).trim() || spec.title;
  const filePath = String(input?.filePath ?? input?.path ?? spec.path).trim() || spec.path;
  const metadata = input?.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? input.metadata
    : {};
  return {
    key,
    title,
    filePath,
    content,
    checksum: String(input?.checksum ?? checksum(content)),
    metadata,
  };
}

export async function readMemoryFiles(rootDir) {
  const root = resolve(rootDir || '.');
  const docs = [];
  for (const spec of MEMORY_DOCUMENTS) {
    const abs = join(root, spec.path);
    try {
      const [content, st] = await Promise.all([readFile(abs, 'utf8'), stat(abs)]);
      docs.push({
        key: spec.key,
        title: spec.title,
        filePath: relative(root, abs).replace(/\\/g, '/'),
        content,
        checksum: checksum(content),
        metadata: {
          source: 'codebase-memory',
          sizeBytes: Buffer.byteLength(content, 'utf8'),
          mtime: st.mtime.toISOString(),
        },
      });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return docs;
}

export async function upsertCodebaseMemoryDocument(s, projectRef, input) {
  const doc = normalizeMemoryInput(input);
  return withClient(clientConfig(s), async (c) => {
    const project = await resolveProjectRow(c, projectRef);
    const r = await c.query(
      `INSERT INTO codebase_memory_documents
        (project_id, doc_key, title, file_path, content, checksum, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (project_id, doc_key) DO UPDATE SET
         title = EXCLUDED.title,
         file_path = EXCLUDED.file_path,
         content = EXCLUDED.content,
         checksum = EXCLUDED.checksum,
         metadata = EXCLUDED.metadata,
         updated_at = now()
       RETURNING *`,
      [project.id, doc.key, doc.title, doc.filePath, doc.content, doc.checksum, JSON.stringify(doc.metadata)],
    );
    return mapDocument(r.rows[0]);
  });
}

export async function syncCodebaseMemoryDocuments(s, projectRef, docs) {
  if (!Array.isArray(docs)) throw httpError(422, 'memory_docs_required', { code: 'memory_docs_required' });
  return withClient(clientConfig(s), async (c) => {
    const project = await resolveProjectRow(c, projectRef);
    const saved = [];
    for (const input of docs) {
      const doc = normalizeMemoryInput(input);
      const r = await c.query(
        `INSERT INTO codebase_memory_documents
          (project_id, doc_key, title, file_path, content, checksum, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (project_id, doc_key) DO UPDATE SET
           title = EXCLUDED.title,
           file_path = EXCLUDED.file_path,
           content = EXCLUDED.content,
           checksum = EXCLUDED.checksum,
           metadata = EXCLUDED.metadata,
           updated_at = now()
         RETURNING *`,
        [project.id, doc.key, doc.title, doc.filePath, doc.content, doc.checksum, JSON.stringify(doc.metadata)],
      );
      saved.push(mapDocument(r.rows[0], { includeContent: false }));
    }
    return { projectId: project.id, synced: saved.length, documents: saved };
  });
}

export async function listCodebaseMemoryDocuments(s, projectRef, { includeContent = false } = {}) {
  return withClient(clientConfig(s), async (c) => {
    const project = await resolveProjectRow(c, projectRef);
    const r = await c.query(
      `SELECT * FROM codebase_memory_documents
        WHERE project_id = $1
        ORDER BY doc_key`,
      [project.id],
    );
    return {
      projectId: project.id,
      documents: r.rows.map((row) => mapDocument(row, { includeContent })),
    };
  });
}

export async function getCodebaseMemoryDocument(s, projectRef, key) {
  const docKey = String(key ?? '').trim();
  if (!MEMORY_KEY_SET.has(docKey)) throw httpError(422, 'memory_key_invalid', { code: 'memory_key_invalid' });
  return withClient(clientConfig(s), async (c) => {
    const project = await resolveProjectRow(c, projectRef);
    const r = await c.query(
      `SELECT * FROM codebase_memory_documents
        WHERE project_id = $1 AND doc_key = $2`,
      [project.id, docKey],
    );
    if (!r.rowCount) throw httpError(404, 'memory_document_not_found', { code: 'memory_document_not_found' });
    return mapDocument(r.rows[0]);
  });
}

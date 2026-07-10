#!/usr/bin/env node
// CODEBASE-MEMORY-AUTOREFRESH-001 — печатает root_path всех НЕ-archived проектов
// оркестратора (по одному в строке) в файл, путь к которому передан первым аргументом.
// Пишем в файл, а не в stdout: импорт config/db печатает служебные лог-строки в stdout,
// которые иначе замусорили бы список. Используется вотчдогом refresh-codebase-memory.ps1
// в режиме -AllProjects, чтобы держать свежей память ВСЕХ проектов, а не только дерева
// ai-dev-manager. Read-only: bootstrap не зовём (миграции не трогаем).
import { writeFileSync } from 'node:fs';
import { loadSettings } from '../orchestrator-service/backend/src/config.js';
import { withClient, clientConfig } from '../orchestrator-service/backend/src/db.js';

const outFile = process.argv[2];
if (!outFile) {
  console.error('usage: node scripts/list-project-roots.mjs <outFile>');
  process.exit(2);
}

const settings = await loadSettings();
const roots = await withClient(clientConfig(settings), async (c) => {
  const r = await c.query(
    `SELECT root_path FROM projects
      WHERE COALESCE(status, 'active') <> 'archived' AND root_path IS NOT NULL
      ORDER BY created_at`,
  );
  return r.rows.map((row) => String(row.root_path).trim()).filter(Boolean);
});

writeFileSync(outFile, roots.join('\n') + (roots.length ? '\n' : ''), 'utf8');

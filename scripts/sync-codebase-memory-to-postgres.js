#!/usr/bin/env node
import { resolve, basename } from 'node:path';
import { loadSettings } from '../orchestrator-service/backend/src/config.js';
import { bootstrap, withClient, clientConfig } from '../orchestrator-service/backend/src/db.js';
import { createOrUpsertProject } from '../orchestrator-service/backend/src/projects.js';
import {
  readMemoryFiles,
  syncCodebaseMemoryDocuments,
} from '../orchestrator-service/backend/src/codebaseMemory.js';

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((v) => v.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const root = resolve(arg('root', process.cwd()));
const projectRef = arg('project', '');
const projectName = arg('name', basename(root));
const allProjects = process.argv.includes('--all-projects');

const settings = await loadSettings();
await bootstrap(settings);

async function syncProject(project, { failOnMissing }) {
  const projectRoot = resolve(project.root_path || project.rootPath || root);
  const docs = await readMemoryFiles(projectRoot);
  if (!docs.length) {
    const skipped = {
      root: projectRoot,
      project: project.id,
      code: project.code,
      name: project.name,
      skipped: true,
      reason: 'no_codebase_memory_files',
    };
    if (failOnMissing) {
      console.error(`No codebase-memory files found under ${projectRoot}. Run codebase-memory analyze first.`);
      process.exit(1);
    }
    return skipped;
  }

  const result = await syncCodebaseMemoryDocuments(settings, project.id, docs);
  return {
    root: projectRoot,
    project: project.id,
    code: project.code,
    name: project.name,
    synced: result.synced,
    documents: result.documents.map((d) => ({ key: d.key, filePath: d.filePath, checksum: d.checksum })),
  };
}

if (allProjects) {
  const projects = await withClient(clientConfig(settings), async (c) => {
    const r = await c.query(
      `SELECT id, code, name, root_path
         FROM projects
        WHERE COALESCE(status, 'active') <> 'archived'
        ORDER BY created_at`,
    );
    return r.rows;
  });
  const results = [];
  for (const project of projects) results.push(await syncProject(project, { failOnMissing: false }));
  console.log(JSON.stringify({ mode: 'all-projects', projects: results }, null, 2));
  process.exit(results.some((r) => r.skipped) ? 2 : 0);
}

const project = projectRef
  ? { id: projectRef }
  : await createOrUpsertProject(settings, { path: root, name: projectName });

console.log(JSON.stringify(await syncProject({ ...project, root_path: root }, { failOnMissing: true }), null, 2));

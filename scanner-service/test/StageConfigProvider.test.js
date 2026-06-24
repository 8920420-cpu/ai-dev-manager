import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  stageConfigsFromProjects,
  createApiStageConfigProvider,
  createSnapshotStageConfigProvider,
} from '../src/StageConfigProvider.js';

// Scanner следит за «папкой документов» проекта (docs_path), если приём включён
// тумблером (scannerEnabled). По одному watcher на проект.
const project = (id, docsPath, scannerEnabled = true) => ({ id, docsPath, scannerEnabled });

test('берёт по одному watcher на проект с папкой документов и включённым приёмом', () => {
  const configs = stageConfigsFromProjects([
    project('p1', 'K:\\proj\\ps\\docs'),
    project('p2', '/srv/orch/docs'),
  ]);
  assert.deepEqual(configs, [
    { projectId: 'p1', stageId: 'docs', watchDirectory: 'K:\\proj\\ps\\docs', documentName: 'claude-tasks.json' },
    { projectId: 'p2', stageId: 'docs', watchDirectory: '/srv/orch/docs', documentName: 'claude-tasks.json' },
  ]);
});

test('пропускает проект без папки документов', () => {
  const configs = stageConfigsFromProjects([
    project('p1', ''),
    project('p2', null),
    { id: 'p3', scannerEnabled: true }, // docsPath отсутствует
  ]);
  assert.equal(configs.length, 0);
});

test('пропускает проект с выключенным приёмом (scannerEnabled=false)', () => {
  const configs = stageConfigsFromProjects([
    project('p1', '/w/docs', false),
    { id: 'p2', docsPath: '/w/docs2' }, // scannerEnabled отсутствует → выключено
  ]);
  assert.equal(configs.length, 0);
});

test('разные проекты дают разные watchDirectory', () => {
  const configs = stageConfigsFromProjects([
    project('ps', '/ps/docs'),
    project('orch', '/orch/docs'),
  ]);
  assert.notEqual(configs[0].watchDirectory, configs[1].watchDirectory);
  assert.deepEqual(configs.map((c) => c.projectId), ['ps', 'orch']);
});

test('API-провайдер парсит ответ /api/projects', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'http://orch/api/projects');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ projects: [project('p1', '/w/docs')] }),
    };
  };
  const provider = createApiStageConfigProvider({ projectsEndpoint: 'http://orch/api/projects', fetchImpl });
  const configs = await provider();
  assert.deepEqual(configs, [
    { projectId: 'p1', stageId: 'docs', watchDirectory: '/w/docs', documentName: 'claude-tasks.json' },
  ]);
});

test('API-провайдер бросает на не-2xx', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const provider = createApiStageConfigProvider({ projectsEndpoint: 'http://orch/api/projects', fetchImpl });
  await assert.rejects(() => provider(), /500/);
});

test('snapshot-провайдер читает форму projects', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'snap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'snapshot.json');
  await writeFile(file, JSON.stringify({ projects: [project('p1', '/w/docs')] }), 'utf8');
  const provider = createSnapshotStageConfigProvider({ snapshotPath: file });
  assert.deepEqual(await provider(), [
    { projectId: 'p1', stageId: 'docs', watchDirectory: '/w/docs', documentName: 'claude-tasks.json' },
  ]);
});

test('snapshot-провайдер читает прямую форму watchers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'snap2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'snapshot.json');
  await writeFile(
    file,
    JSON.stringify({ watchers: [{ projectId: 'p1', stageId: 'docs', watchDirectory: '/w/docs' }] }),
    'utf8',
  );
  const provider = createSnapshotStageConfigProvider({ snapshotPath: file });
  assert.deepEqual(await provider(), [
    { projectId: 'p1', stageId: 'docs', watchDirectory: '/w/docs', documentName: 'claude-tasks.json' },
  ]);
});

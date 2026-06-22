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

const project = (id, stages) => ({ id, stages });
const scannerStage = (id, watchDirectory, { enabled = true } = {}) => ({
  id,
  name: 'Scanner',
  enabled,
  roleCodes: ['SCANNER'],
  scanner: { watchDirectory },
});

test('берёт только включённые SCANNER-этапы с папкой', () => {
  const configs = stageConfigsFromProjects([
    project('p1', [
      { id: 's-prog', name: 'Programmer', enabled: true, roleCodes: ['PROGRAMMER'] }, // не Scanner
      scannerStage('s-scan', 'K:\\proj\\ps\\tasks'),
    ]),
    project('p2', [scannerStage('s-scan2', '/srv/orch/tasks')]),
  ]);
  assert.deepEqual(configs, [
    { projectId: 'p1', stageId: 's-scan', watchDirectory: 'K:\\proj\\ps\\tasks', documentName: 'claude-tasks.json' },
    { projectId: 'p2', stageId: 's-scan2', watchDirectory: '/srv/orch/tasks', documentName: 'claude-tasks.json' },
  ]);
});

test('пропускает отключённый Scanner и Scanner без папки', () => {
  const configs = stageConfigsFromProjects([
    project('p1', [
      scannerStage('s-off', '/srv/x', { enabled: false }),
      scannerStage('s-nodir', ''),
    ]),
  ]);
  assert.equal(configs.length, 0);
});

test('разные проекты дают разные watchDirectory', () => {
  const configs = stageConfigsFromProjects([
    project('ps', [scannerStage('a', '/ps/tasks')]),
    project('orch', [scannerStage('b', '/orch/tasks')]),
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
      text: async () => JSON.stringify({ projects: [project('p1', [scannerStage('s', '/w/tasks')])] }),
    };
  };
  const provider = createApiStageConfigProvider({ projectsEndpoint: 'http://orch/api/projects', fetchImpl });
  const configs = await provider();
  assert.deepEqual(configs, [
    { projectId: 'p1', stageId: 's', watchDirectory: '/w/tasks', documentName: 'claude-tasks.json' },
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
  await writeFile(file, JSON.stringify({ projects: [project('p1', [scannerStage('s', '/w/tasks')])] }), 'utf8');
  const provider = createSnapshotStageConfigProvider({ snapshotPath: file });
  assert.deepEqual(await provider(), [
    { projectId: 'p1', stageId: 's', watchDirectory: '/w/tasks', documentName: 'claude-tasks.json' },
  ]);
});

test('snapshot-провайдер читает прямую форму watchers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'snap2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'snapshot.json');
  await writeFile(
    file,
    JSON.stringify({ watchers: [{ projectId: 'p1', stageId: 's', watchDirectory: '/w/tasks' }] }),
    'utf8',
  );
  const provider = createSnapshotStageConfigProvider({ snapshotPath: file });
  assert.deepEqual(await provider(), [
    { projectId: 'p1', stageId: 's', watchDirectory: '/w/tasks', documentName: 'claude-tasks.json' },
  ]);
});

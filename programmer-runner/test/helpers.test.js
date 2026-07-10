import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRepo, loadRepoMap } from '../src/repoResolver.js';
import { buildPrompt, parseAgentJson } from '../src/promptBuilder.js';

test('resolveRepo: PROJECT_2 → дерево ПС с GOWORK=off', () => {
  const { cwd, env } = resolveRepo({ project: 'PROJECT_2' });
  assert.match(cwd, /PS$/);
  assert.equal(env.GOWORK, 'off');
});

test('resolveRepo: неизвестный проект → явная ошибка', () => {
  assert.throws(() => resolveRepo({ project: 'NOPE' }), /неизвестный проект/);
});

test('loadRepoMap: PROGRAMMER_REPO_MAP переопределяет/дополняет дефолт', () => {
  const map = loadRepoMap({ PROGRAMMER_REPO_MAP: '{"PROJECT_3":{"cwd":"/tmp/p3"}}' });
  assert.equal(map.PROJECT_3.cwd, '/tmp/p3');
  assert.ok(map.PROJECT_2, 'дефолтные проекты сохраняются');
});

test('loadRepoMap: битый JSON → дефолт без падения', () => {
  const map = loadRepoMap({ PROGRAMMER_REPO_MAP: '{не json' });
  assert.ok(map.PROJECT_2);
});

test('parseAgentJson: достаёт финальный JSON-блок из текста', () => {
  const text = 'Готово.\nИзменил файлы.\n{"success": true, "summary": "ok", "files_changed": ["a.go"]}';
  const parsed = parseAgentJson(text);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.files_changed, ['a.go']);
});

test('parseAgentJson: нет JSON → null', () => {
  assert.equal(parseAgentJson('просто текст без json'), null);
  assert.equal(parseAgentJson(null), null);
});

test('buildPrompt: включает заголовок, описание и требование финального JSON', () => {
  const prompt = buildPrompt({
    project: 'PROJECT_2',
    service: 'IAM',
    title: 'IAM-ORG-001',
    description: 'Назначать создателя компании owner.',
    capabilities: ['read', 'modify'],
    priorRoleOutputs: [
      { role: 'ARCHITECT', status: 'READY', summary: 'арх-решение', findings: ['факт1'] },
    ],
  });
  assert.match(prompt, /IAM-ORG-001/);
  assert.match(prompt, /Назначать создателя/);
  assert.match(prompt, /ARCHITECT/);
  assert.match(prompt, /files_changed/);
  assert.match(prompt, /PROGRAMMER/);
  assert.match(prompt, /Do not invent requirements/);
  assert.match(prompt, /Required Final Response/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fastForwardHiddenRoles } from '../src/rolePipeline.js';
import {
  mergePromptAndSkills,
  isSkillPathAllowed,
  resolveSkillPath,
  canonicalSkillId,
  normalizeRoleUpdate,
  listAvailableSkills,
  normalizeSkillUpload,
  uploadSkill,
} from '../src/roles.js';
import { readFile } from 'node:fs/promises';

// --- fastForwardHiddenRoles: пропуск скрытых ролей --------------------------

test('нет скрытых ролей → переход не меняется', () => {
  const ff = fastForwardHiddenRoles('DECOMPOSER', 'DECOMPOSITION', () => false);
  assert.deepEqual(ff, { nextRole: 'DECOMPOSER', toStatus: 'DECOMPOSITION', done: false, skipped: [] });
});

test('одна скрытая роль пропускается до следующей активной', () => {
  const hidden = new Set(['DECOMPOSER']);
  const ff = fastForwardHiddenRoles('DECOMPOSER', 'DECOMPOSITION', (c) => hidden.has(c));
  assert.equal(ff.nextRole, 'PROGRAMMER');
  assert.equal(ff.toStatus, 'CODING'); // DECOMPOSER.to
  assert.equal(ff.done, false);
  assert.deepEqual(ff.skipped, ['DECOMPOSER']);
});

test('две скрытые роли подряд → следующая активная роль', () => {
  const hidden = new Set(['DECOMPOSER', 'PROGRAMMER']);
  const ff = fastForwardHiddenRoles('DECOMPOSER', 'DECOMPOSITION', (c) => hidden.has(c));
  assert.equal(ff.nextRole, 'TASK_REVIEWER');
  assert.equal(ff.toStatus, 'REVIEW'); // PROGRAMMER.to
  assert.deepEqual(ff.skipped, ['DECOMPOSER', 'PROGRAMMER']);
});

test('скрытая последняя роль маршрута → задача завершается (DONE)', () => {
  const hidden = new Set(['DOCUMENTATION_AUDITOR', 'GIT_INTEGRATOR']);
  const ff = fastForwardHiddenRoles('DOCUMENTATION_AUDITOR', 'COMMIT', (c) => hidden.has(c));
  assert.equal(ff.nextRole, null);
  assert.equal(ff.done, true);
  assert.equal(ff.toStatus, 'DONE');
  assert.deepEqual(ff.skipped, ['DOCUMENTATION_AUDITOR', 'GIT_INTEGRATOR']);
});

test('переход уже завершён (nextRole=null) не зацикливается', () => {
  const ff = fastForwardHiddenRoles(null, 'DONE', () => true);
  assert.deepEqual(ff, { nextRole: null, toStatus: 'DONE', done: true, skipped: [] });
});

// --- mergePromptAndSkills: порядок объединения промта и skills --------------

test('порядок объединения: базовый промт, затем skills по порядку', () => {
  const out = mergePromptAndSkills('BASE', [
    { path: 'a.md', content: 'AAA' },
    { path: 'sub/b.md', content: 'BBB' },
  ]);
  assert.ok(out.startsWith('BASE'));
  assert.ok(out.indexOf('# Skill: a.md') < out.indexOf('# Skill: sub/b.md'));
  assert.ok(out.indexOf('AAA') < out.indexOf('BBB'));
});

test('пустые skill-содержимые пропускаются', () => {
  const out = mergePromptAndSkills('BASE', [{ path: 'a.md', content: '   ' }]);
  assert.equal(out, 'BASE');
});

// --- Валидация skill-путей ---------------------------------------------------

test('canonicalSkillId нормализует слэши и срезает ./', () => {
  assert.equal(canonicalSkillId('.\\sub\\a.md'), 'sub/a.md');
  assert.equal(canonicalSkillId('./a.md'), 'a.md');
  assert.equal(canonicalSkillId(''), '');
});

test('isSkillPathAllowed отклоняет traversal/абсолютные/неверное расширение', () => {
  assert.equal(isSkillPathAllowed('a.md'), true);
  assert.equal(isSkillPathAllowed('sub/b.txt'), true);
  assert.equal(isSkillPathAllowed('../secret.md'), false);
  assert.equal(isSkillPathAllowed('sub/../../x.md'), false);
  assert.equal(isSkillPathAllowed('/etc/passwd'), false);
  assert.equal(isSkillPathAllowed('C:/win.md'), false);
  assert.equal(isSkillPathAllowed('a.js'), false);
  assert.equal(isSkillPathAllowed(''), false);
});

test('resolveSkillPath: traversal → null, валидный → внутри каталога', () => {
  const dir = join(tmpdir(), 'skills-base');
  assert.equal(resolveSkillPath('../escape.md', { dir }), null);
  const ok = resolveSkillPath('group/a.md', { dir });
  assert.ok(ok && ok.startsWith(dir));
});

// --- normalizeRoleUpdate -----------------------------------------------------

test('normalizeRoleUpdate: частичный patch только с переданными полями', () => {
  const patch = normalizeRoleUpdate({ description: 'd' });
  assert.deepEqual(patch, { description: 'd' });
});

test('normalizeRoleUpdate: пустой prompt → null (файловый fallback)', () => {
  const patch = normalizeRoleUpdate({ prompt: '   ' });
  assert.equal(patch.prompt, null);
});

test('normalizeRoleUpdate: hidden только boolean', () => {
  assert.deepEqual(normalizeRoleUpdate({ hidden: true }), { hidden: true });
  assert.throws(() => normalizeRoleUpdate({ hidden: 'yes' }), /role_hidden_must_be_boolean/);
});

test('normalizeRoleUpdate: groupId — uuid, либо null/пусто = открепить', () => {
  assert.deepEqual(normalizeRoleUpdate({ groupId: 'g1' }), { groupId: 'g1' });
  assert.deepEqual(normalizeRoleUpdate({ groupId: null }), { groupId: null });
  assert.deepEqual(normalizeRoleUpdate({ groupId: '' }), { groupId: null });
  assert.deepEqual(normalizeRoleUpdate({ groupId: '  g2  ' }), { groupId: 'g2' });
  assert.throws(() => normalizeRoleUpdate({ groupId: 123 }), /role_group_invalid/);
});

test('normalizeRoleUpdate: дубль skill отклоняется', () => {
  assert.throws(
    () => normalizeRoleUpdate({ skills: ['a.md', './a.md'] }),
    /role_skill_duplicate/,
  );
});

test('normalizeRoleUpdate: неизвестный skill отклоняется при validSkillPaths', () => {
  assert.throws(
    () => normalizeRoleUpdate({ skills: ['x.md'] }, { validSkillPaths: new Set(['a.md']) }),
    /role_skill_unknown/,
  );
  const ok = normalizeRoleUpdate({ skills: ['a.md'] }, { validSkillPaths: new Set(['a.md']) });
  assert.deepEqual(ok.skills, ['a.md']);
});

test('normalizeRoleUpdate: traversal-путь отклоняется', () => {
  assert.throws(() => normalizeRoleUpdate({ skills: ['../x.md'] }), /role_skill_invalid_path/);
});

test('normalizeRoleUpdate: слишком длинное описание отклоняется', () => {
  assert.throws(() => normalizeRoleUpdate({ description: 'x'.repeat(2001) }), /role_description_too_long/);
});

// --- listAvailableSkills: рекурсивный список внутри каталога -----------------

test('listAvailableSkills возвращает .md/.txt рекурсивно, игнорит dotfiles и прочее', async () => {
  const base = await mkdtemp(join(tmpdir(), 'skills-'));
  try {
    await writeFile(join(base, 'root.md'), 'r');
    await writeFile(join(base, 'note.txt'), 't');
    await writeFile(join(base, 'ignore.js'), 'j');
    await writeFile(join(base, '.hidden.md'), 'h');
    await mkdir(join(base, 'group'), { recursive: true });
    await writeFile(join(base, 'group', 'a.md'), 'a');
    const { skills } = await listAvailableSkills({ dir: base });
    const ids = skills.map((x) => x.id);
    assert.deepEqual(ids, ['group/a.md', 'note.txt', 'root.md']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('listAvailableSkills: несуществующий каталог → пустой список', async () => {
  const { skills } = await listAvailableSkills({ dir: join(tmpdir(), 'no-such-skills-dir-xyz') });
  assert.deepEqual(skills, []);
});

// --- normalizeSkillUpload: валидация загрузки skill с ПК ---------------------

test('normalizeSkillUpload: валидный .md → { name, content }', () => {
  const r = normalizeSkillUpload({ name: 'my-skill.md', content: '# Skill\nтекст' });
  assert.deepEqual(r, { name: 'my-skill.md', content: '# Skill\nтекст' });
});

test('normalizeSkillUpload: путь с каталогами/traversal → только базовое имя', () => {
  const r = normalizeSkillUpload({ name: '../../etc/passwd.txt', content: 'x' });
  assert.equal(r.name, 'passwd.txt');
});

test('normalizeSkillUpload: запрещённое расширение → 422', () => {
  assert.throws(() => normalizeSkillUpload({ name: 'evil.js', content: 'x' }), /skill_extension_invalid/);
});

test('normalizeSkillUpload: пустое содержимое → 422', () => {
  assert.throws(() => normalizeSkillUpload({ name: 'a.md', content: '   ' }), /skill_content_empty/);
});

test('normalizeSkillUpload: имя из точки/без имени → 422', () => {
  assert.throws(() => normalizeSkillUpload({ name: '.md', content: 'x' }), /skill_name_invalid/);
  assert.throws(() => normalizeSkillUpload({ name: '', content: 'x' }), /skill_name_invalid/);
});

// --- uploadSkill: запись файла в каталог skills -----------------------------

test('uploadSkill пишет файл в каталог skills и возвращает id', async () => {
  const base = await mkdtemp(join(tmpdir(), 'skills-up-'));
  try {
    const out = await uploadSkill({ name: 'guide.md', content: 'привет' }, { dir: base });
    assert.deepEqual(out, { id: 'guide.md', name: 'guide.md' });
    assert.equal(await readFile(join(base, 'guide.md'), 'utf8'), 'привет');
    // Появляется в списке доступных.
    const { skills } = await listAvailableSkills({ dir: base });
    assert.deepEqual(skills.map((s) => s.id), ['guide.md']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('uploadSkill создаёт отсутствующий каталог и перезаписывает по имени', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-up2-'));
  const base = join(root, 'nested', 'skills');
  try {
    await uploadSkill({ name: 'a.txt', content: 'v1' }, { dir: base });
    await uploadSkill({ name: 'a.txt', content: 'v2' }, { dir: base });
    assert.equal(await readFile(join(base, 'a.txt'), 'utf8'), 'v2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

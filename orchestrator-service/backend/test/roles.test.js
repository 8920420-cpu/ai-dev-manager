import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fastForwardHiddenRoles, roleHasExecutor } from '../src/rolePipeline.js';
import {
  mergePromptAndSkills,
  isSkillPathAllowed,
  resolveSkillPath,
  canonicalSkillId,
  normalizeRoleUpdate,
  listAvailableSkills,
  normalizeSkillUpload,
  uploadSkill,
  composeRoleSystemPrompt,
  RESEARCH_ROLES,
  promptHash,
  recordPromptVersion,
  resolveRoleMaxTurns,
  estimateEpicServiceCount,
  ARCHITECT_TURN_SCALE,
} from '../src/roles.js';
import { readFile } from 'node:fs/promises';

// --- ARCHITECT-TURN-CAP-001: персональный кап ходов роли ---------------------

test('resolveRoleMaxTurns: дефолт Архитектора = 24, у прочих ролей null', () => {
  const prev = process.env.ARCHITECT_MAX_TURNS;
  delete process.env.ARCHITECT_MAX_TURNS;
  try {
    assert.equal(resolveRoleMaxTurns('ARCHITECT'), 24);
    assert.equal(resolveRoleMaxTurns('TASK_REVIEWER'), null);
    assert.equal(resolveRoleMaxTurns(''), null);
    assert.equal(resolveRoleMaxTurns(null), null);
  } finally {
    if (prev === undefined) delete process.env.ARCHITECT_MAX_TURNS;
    else process.env.ARCHITECT_MAX_TURNS = prev;
  }
});

test('resolveRoleMaxTurns: env ${ROLE}_MAX_TURNS переопределяет дефолт', () => {
  const prev = process.env.ARCHITECT_MAX_TURNS;
  try {
    process.env.ARCHITECT_MAX_TURNS = '16';
    assert.equal(resolveRoleMaxTurns('ARCHITECT'), 16);
    process.env.ARCHITECT_MAX_TURNS = '0'; // невалидно → дефолт
    assert.equal(resolveRoleMaxTurns('ARCHITECT'), 24);
    process.env.ARCHITECT_MAX_TURNS = 'abc'; // мусор → дефолт
    assert.equal(resolveRoleMaxTurns('ARCHITECT'), 24);
  } finally {
    if (prev === undefined) delete process.env.ARCHITECT_MAX_TURNS;
    else process.env.ARCHITECT_MAX_TURNS = prev;
  }
});

// --- ARCHITECT-BUDGET-SCALE-001: масштабирование капа ходов по размеру эпика --

test('estimateEpicServiceCount: явное число сервисов/фронтов из описания', () => {
  assert.equal(estimateEpicServiceCount('раскатка виджета на 14 фронтов ПС'), 14);
  assert.equal(estimateEpicServiceCount('эпик на 14 сервисов'), 14);
  assert.equal(estimateEpicServiceCount('на 14-сервисном эпике'), 14);
  assert.equal(estimateEpicServiceCount('rollout across 8 services'), 8);
  // Берём МАКСИМУМ из нескольких упоминаний.
  assert.equal(estimateEpicServiceCount('2 фронта сейчас, потом ещё 12 сервисов'), 12);
  // Нет явного числа — 0.
  assert.equal(estimateEpicServiceCount('обычная правка одного файла'), 0);
  assert.equal(estimateEpicServiceCount(''), 0);
  assert.equal(estimateEpicServiceCount(null), 0);
});

test('resolveRoleMaxTurns: без sizeCtx — прежнее фиксированное значение (совместимость)', () => {
  const prev = process.env.ARCHITECT_MAX_TURNS;
  delete process.env.ARCHITECT_MAX_TURNS;
  try {
    assert.equal(resolveRoleMaxTurns('ARCHITECT'), 24);
    // Пустой/бессодержательный sizeCtx не меняет базу.
    assert.equal(resolveRoleMaxTurns('ARCHITECT', { description: '' }), 24);
    assert.equal(resolveRoleMaxTurns('ARCHITECT', 'мелкая правка'), 24);
  } finally {
    if (prev === undefined) delete process.env.ARCHITECT_MAX_TURNS;
    else process.env.ARCHITECT_MAX_TURNS = prev;
  }
});

test('resolveRoleMaxTurns: мега-эпик на 14 фронтов масштабирует кап (до потолка)', () => {
  const prev = process.env.ARCHITECT_MAX_TURNS;
  delete process.env.ARCHITECT_MAX_TURNS;
  try {
    const turns = resolveRoleMaxTurns('ARCHITECT', { description: 'раскатка виджета на 14 фронтов ПС' });
    // База 24 + (14-2)*3 = 60 → упирается в потолок.
    assert.equal(turns, ARCHITECT_TURN_SCALE.max);
    assert.ok(turns > 24, 'кап вырос относительно базового 24');
    // Строка-описание принимается напрямую.
    assert.equal(resolveRoleMaxTurns('ARCHITECT', 'на 14 сервисов'), ARCHITECT_TURN_SCALE.max);
  } finally {
    if (prev === undefined) delete process.env.ARCHITECT_MAX_TURNS;
    else process.env.ARCHITECT_MAX_TURNS = prev;
  }
});

test('resolveRoleMaxTurns: эпик среднего размера растёт линейно и не превышает потолок', () => {
  const prev = process.env.ARCHITECT_MAX_TURNS;
  delete process.env.ARCHITECT_MAX_TURNS;
  try {
    // 5 сервисов: 24 + (5-2)*3 = 33.
    assert.equal(resolveRoleMaxTurns('ARCHITECT', { description: 'работа на 5 сервисов' }), 33);
    // Длинное описание (прокси объёма): 6000 знаков → 24 + floor((6000-2000)/1000)*2 = 32.
    assert.equal(resolveRoleMaxTurns('ARCHITECT', { description: 'x'.repeat(6000) }), 32);
    // Никогда не выше потолка.
    assert.ok(resolveRoleMaxTurns('ARCHITECT', { description: 'на 99 сервисов' }) <= ARCHITECT_TURN_SCALE.max);
  } finally {
    if (prev === undefined) delete process.env.ARCHITECT_MAX_TURNS;
    else process.env.ARCHITECT_MAX_TURNS = prev;
  }
});

test('resolveRoleMaxTurns: масштабируется только ARCHITECT, прочие роли — без изменений', () => {
  // Для НЕ-Архитектора sizeCtx не влияет: результат такой же, как без sizeCtx
  // (робастно к ambient-env вроде PROGRAMMER_MAX_TURNS). У ролей без env/дефолта — null.
  const bigEpic = { description: 'на 14 сервисов' };
  for (const role of ['TASK_REVIEWER', 'PROGRAMMER', 'DECOMPOSER']) {
    assert.equal(
      resolveRoleMaxTurns(role, bigEpic),
      resolveRoleMaxTurns(role),
      `${role}: sizeCtx не меняет кап (масштабируется только ARCHITECT)`,
    );
  }
});

test('resolveRoleMaxTurns: явный env-кап выше потолка не понижается масштабированием', () => {
  const prev = process.env.ARCHITECT_MAX_TURNS;
  try {
    process.env.ARCHITECT_MAX_TURNS = '100'; // оператор задал большой кап явно
    assert.equal(resolveRoleMaxTurns('ARCHITECT', { description: 'на 14 сервисов' }), 100);
  } finally {
    if (prev === undefined) delete process.env.ARCHITECT_MAX_TURNS;
    else process.env.ARCHITECT_MAX_TURNS = prev;
  }
});

// --- VERSION-KPI-TRACKING-001: версионирование промтов -----------------------

test('promptHash: одинаковый текст → одинаковый хеш, разный → разный', () => {
  assert.equal(promptHash('привет'), promptHash('привет'));
  assert.notEqual(promptHash('привет'), promptHash('пока'));
});

test('promptHash: косметика (CRLF / хвостовые пробелы) не меняет хеш', () => {
  assert.equal(promptHash('строка\nдва'), promptHash('строка\r\nдва'));
  assert.equal(promptHash('строка  \nдва'), promptHash('строка\nдва'));
});

// Фейковый клиент pg: отвечает по подстроке SQL, копит выполненные запросы.
function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [needle, rows] of responses) {
        if (sql.includes(needle)) return { rowCount: rows.length, rows };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

test('recordPromptVersion: тот же текст что у активной версии → дедуп, новая не создаётся', async () => {
  const text = 'Ты — Архитектор.';
  // Дедуп по тексту: даже с косметикой (CRLF) активной версии хеш совпадёт.
  const c = fakeClient([
    ['is_active = true LIMIT 1', [{ version: 3, prompt_text: text.replace('\n', '\r\n') }]],
  ]);
  const res = await recordPromptVersion(c, 'role-1', text);
  assert.deepEqual(res, { version: 3, created: false });
  // Не должно быть INSERT новой версии.
  assert.ok(!c.calls.some((q) => q.sql.includes('INSERT INTO prompts')));
});

test('recordPromptVersion: изменённый текст → новая версия = max+1, старые деактивированы', async () => {
  const c = fakeClient([
    ['is_active = true LIMIT 1', [{ version: 2, prompt_text: 'старый' }]],
    ['COALESCE(max(version)', [{ v: 2 }]],
  ]);
  const res = await recordPromptVersion(c, 'role-1', 'новый текст', { label: 'эксперимент' });
  assert.deepEqual(res, { version: 3, created: true });
  assert.ok(c.calls.some((q) => q.sql.includes('UPDATE prompts SET is_active = false')));
  const ins = c.calls.find((q) => q.sql.includes('INSERT INTO prompts'));
  assert.ok(ins);
  // params: role_id, version, body, hash, label, author
  assert.equal(ins.params[1], 3);
  assert.equal(ins.params[4], 'эксперимент');
});

test('recordPromptVersion: первая версия роли (нет активной) → version=1, created', async () => {
  const c = fakeClient([
    ['is_active = true LIMIT 1', []],
    ['COALESCE(max(version)', [{ v: 0 }]],
  ]);
  const res = await recordPromptVersion(c, 'role-1', 'первый промт');
  assert.deepEqual(res, { version: 1, created: true });
});

// --- roleHasExecutor: исполнимость роли (ROLE-NO-EXECUTOR-001) ---------------

test('roleHasExecutor: true для ролей с исполнителем (ARCHITECT/PROGRAMMER/SCANNER)', () => {
  // Исполним ⇔ есть в ROLE_FLOW: auto-роль ведёт runner (ARCHITECT),
  // PROGRAMMER/SCANNER исполняются через мосты.
  assert.equal(roleHasExecutor('ARCHITECT'), true);
  assert.equal(roleHasExecutor('PROGRAMMER'), true);
  assert.equal(roleHasExecutor('SCANNER'), true);
});

test('roleHasExecutor: false для скрываемых ролей без исполнителя', () => {
  for (const code of ['STRUCTURE_KEEPER', 'TESTER', 'REVIEWER', 'COMMITTER', 'DEPLOYER']) {
    assert.equal(roleHasExecutor(code), false, `${code} не имеет исполнителя`);
  }
});

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

// --- composeRoleSystemPrompt: бюджет разведки (RESEARCH-BUDGET-001) ----------

// Фейк-клиент БД: роль с заданным prompt, без подключённых skills.
function fakeRoleClient(prompt) {
  return {
    async query(sql) {
      if (/FROM roles WHERE code/.test(sql)) return { rowCount: 1, rows: [{ prompt, hidden: false }] };
      return { rowCount: 0, rows: [] }; // role_skills и пр.
    },
  };
}

test('composeRoleSystemPrompt: исследующая роль получает бюджет разведки и правило данных', async () => {
  const sys = await composeRoleSystemPrompt(fakeRoleClient('BASE'), 'ARCHITECT', { skillsDir: '/no-such-skills' });
  assert.ok(sys.startsWith('BASE'));
  assert.match(sys, /ОБЯЗАТЕЛЬНОЕ ПРАВИЛО ДАННЫХ/);
  assert.match(sys, /БЮДЖЕТ РАЗВЕДКИ/);
});

test('composeRoleSystemPrompt: роль-исполнитель НЕ получает бюджет разведки', async () => {
  const sys = await composeRoleSystemPrompt(fakeRoleClient('BASE'), 'PROGRAMMER', { skillsDir: '/no-such-skills' });
  assert.match(sys, /ОБЯЗАТЕЛЬНОЕ ПРАВИЛО ДАННЫХ/);
  assert.doesNotMatch(sys, /БЮДЖЕТ РАЗВЕДКИ/);
});

test('RESEARCH_ROLES включает Архитектора и Декомпозитора', () => {
  assert.ok(RESEARCH_ROLES.has('ARCHITECT'));
  assert.ok(RESEARCH_ROLES.has('DECOMPOSER'));
  assert.ok(!RESEARCH_ROLES.has('PROGRAMMER'));
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

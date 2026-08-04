import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLUGIN_NAME, detectStack, normalizeStack, qualify, resolveSkillsDir,
  skillHintForRole, skillHintForStack, skillOptionsForRole, skillOptionsForStack,
  skillsForRole, skillsForStack,
} from '../src/skillProfiles.js';

// AGENT-SKILLS-001 / STACK-SPECIALIZATION-001.

test('normalizeStack: синонимы сводятся к go|proto|next, мусор → null', () => {
  assert.equal(normalizeStack('Go'), 'go');
  assert.equal(normalizeStack('backend'), 'go');
  assert.equal(normalizeStack('grpc'), 'proto');
  assert.equal(normalizeStack('protobuf'), 'proto');
  assert.equal(normalizeStack('NextJS'), 'next');
  assert.equal(normalizeStack('фронтенд'), 'next');
  assert.equal(normalizeStack('rust'), null);
  assert.equal(normalizeStack(''), null);
  assert.equal(normalizeStack(undefined), null);
});

test('detectStack: явное поле задачи важнее текста описания', () => {
  const task = { stack: 'frontend', description: 'правки в internal/api/handler.go и go.mod' };
  assert.equal(detectStack(task), 'next');
});

test('detectStack: по путям файлов из описания', () => {
  assert.equal(detectStack({ description: 'обновить internal/store/repo.go, покрыть go test' }), 'go');
  assert.equal(detectStack({ description: 'добавить поле в app/components/Card.tsx' }), 'next');
});

// Контракт первичен: задача «правь proto и перегенерируй Go» — это работа со
// стеком proto, иначе агент получит Go-профиль и потеряет правила совместимости.
test('detectStack: proto перевешивает go при смешанном описании', () => {
  const task = { description: 'изменить api/chat/v1/chat.proto и обновить internal/grpc/server.go' };
  assert.equal(detectStack(task), 'proto');
});

test('detectStack: сигналы берутся и из вывода предыдущих ролей', () => {
  const task = {
    description: 'сделать по плану Архитектора',
    priorRoleOutputs: [{ role: 'ARCHITECT', summary: 'править web/app/page.tsx', findings: ['next.config.mjs'] }],
  };
  assert.equal(detectStack(task), 'next');
});

test('detectStack: нечего распознавать → null', () => {
  assert.equal(detectStack({ title: 'обновить документацию' }), null);
  assert.equal(detectStack({}), null);
});

test('skillsForStack: профиль стека + общие скилы, без дублей', () => {
  const go = skillsForStack('go');
  assert.ok(go.includes('go-service-engineer'));
  assert.ok(go.includes('security-reviewer'), 'общие скилы добавляются к любому стеку');
  assert.ok(!go.includes('nextjs-app-router'), 'чужой стек не подмешивается');
  assert.equal(go.length, new Set(go).size);

  const proto = skillsForStack('proto');
  assert.ok(proto.includes('protobuf-contracts') && proto.includes('grpc-api-design'));
});

test('skillsForStack: стек неизвестен → объединение всех стеков (агент выберет сам)', () => {
  const all = skillsForStack(null);
  assert.ok(all.includes('go-service-engineer'));
  assert.ok(all.includes('protobuf-contracts'));
  assert.ok(all.includes('nextjs-app-router'));
});

test('skillsForRole: профиль рассуждающей роли; роль без профиля → пусто', () => {
  assert.ok(skillsForRole('ARCHITECT').includes('system-architect'));
  assert.ok(skillsForRole('architect').includes('system-architect'), 'регистр не важен');
  assert.ok(skillsForRole('TASK_REVIEWER').includes('go-code-review'));
  assert.deepEqual(skillsForRole('TASK_INTAKE_OFFICER'), []);
  assert.deepEqual(skillsForRole(''), []);
});

test('qualify: имя дополняется префиксом плагина, уже квалифицированное — нет', () => {
  assert.equal(qualify('go-code-review'), `${PLUGIN_NAME}:go-code-review`);
  assert.equal(qualify(`${PLUGIN_NAME}:go-code-review`), `${PLUGIN_NAME}:go-code-review`);
});

test('resolveSkillsDir: AGENT_SKILLS_DIR перекрывает дефолт', () => {
  const custom = resolveSkillsDir({ AGENT_SKILLS_DIR: 'C:/tmp/skills' });
  assert.match(custom.replace(/\\/g, '/'), /C:\/tmp\/skills$/);
  assert.match(resolveSkillsDir({}).replace(/\\/g, '/'), /agent-skills$/);
});

test('skillOptionsForStack: реальный каталог плагина → plugins + квалифицированные skills', () => {
  const opts = skillOptionsForStack('go', {});
  assert.equal(opts.plugins.length, 1);
  assert.equal(opts.plugins[0].type, 'local');
  assert.equal(opts.plugins[0].skipMcpDiscovery, true);
  assert.match(opts.plugins[0].path.replace(/\\/g, '/'), /agent-skills$/);
  assert.ok(opts.skills.every((s) => s.startsWith(`${PLUGIN_NAME}:`)));
  assert.ok(opts.skills.includes(`${PLUGIN_NAME}:go-service-engineer`));
});

test('skillOptionsForRole: профиль роли, а НЕ программистский набор', () => {
  const opts = skillOptionsForRole('ARCHITECT', {});
  assert.ok(opts.skills.includes(`${PLUGIN_NAME}:system-architect`));
  assert.ok(!opts.skills.includes(`${PLUGIN_NAME}:go-service-engineer`),
    'рассуждающая роль не должна получать скилы реализации');
});

// Роль без профиля не должна проваливаться в набор по стеку: пустая роль у
// рассуждающего раннера означала бы «дать всё», раздувая контекст впустую.
test('skillOptionsForRole: роль без профиля / пустая → пустые опции', () => {
  assert.deepEqual(skillOptionsForRole('TASK_ROUTER', {}), {});
  assert.deepEqual(skillOptionsForRole(undefined, {}), {});
});

test('skillOptions*: AGENT_SKILLS=0 выключает скилы целиком', () => {
  assert.deepEqual(skillOptionsForStack('go', { AGENT_SKILLS: '0' }), {});
  assert.deepEqual(skillOptionsForStack('go', { AGENT_SKILLS: 'off' }), {});
  assert.deepEqual(skillOptionsForRole('ARCHITECT', { AGENT_SKILLS: '0' }), {});
});

// Каталога нет (битый AGENT_SKILLS_DIR) → прогон идёт как раньше, а не падает.
test('skillOptionsForStack: нет каталога плагина → пустые опции', () => {
  assert.deepEqual(skillOptionsForStack('go', { AGENT_SKILLS_DIR: 'C:/nope/missing' }), {});
});

test('skillHintForStack: перечисляет ровно те скилы, что поданы в SDK', () => {
  const hint = skillHintForStack('proto', {});
  assert.match(hint, /## Skills/);
  assert.match(hint, /Task stack: proto/);
  for (const name of skillOptionsForStack('proto', {}).skills) {
    assert.ok(hint.includes(name), `в подсказке нет ${name}`);
  }
  assert.equal(skillHintForStack('proto', { AGENT_SKILLS: '0' }), '');
});

test('skillHintForRole: пустая строка для роли без профиля', () => {
  assert.match(skillHintForRole('TASK_REVIEWER', {}), /go-code-review/);
  assert.equal(skillHintForRole('TASK_INTAKE_OFFICER', {}), '');
});

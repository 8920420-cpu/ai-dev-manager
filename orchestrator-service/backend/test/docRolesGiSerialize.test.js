// DOCROLES-GI-SERIALIZE-001 — сериализация doc-ветви и fork-ребёнка Git Integrator
// по общему рабочему дереву сервиса + проброс changedFiles doc-сиблингов в контекст GI.
// Мини-клиент pg (как в forkJoin.test.js): отвечает по первому regex-правилу.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveSiblingDocChangedFiles } from '../src/db.js';
import { DOC_BRANCH_ROLE_CODES, decideOutcome } from '../src/roleEngine.js';

function fakeClient(rules) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const rule of rules) {
        if (rule.re.test(sql)) {
          rule.hits = (rule.hits ?? 0) + 1;
          const out = typeof rule.reply === 'function' ? rule.reply(rule.hits, params) : rule.reply;
          return out ?? { rows: [], rowCount: 0 };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const SIB_RE = /FROM tasks WHERE parent_task_id = \$1 AND id <> \$2/;

// --- resolveSiblingDocChangedFiles: агрегация правок doc-сиблингов ------------

test('resolveSiblingDocChangedFiles: объединяет changedFiles сиблингов с дедупом', async () => {
  const c = fakeClient([
    { re: SIB_RE, reply: { rowCount: 2, rows: [
      // doc-ветвь: Doc Keeper отредактировал README и API.
      { data_card: { changedFiles: ['packages/app-switcher/README.md', 'docs/API.md'] } },
      // ещё одна doc-ветвь с пересечением (docs/API.md) — дедуп.
      { data_card: { changedFiles: ['docs/API.md', 'docs/ARCH.md'] } },
    ] } },
  ]);
  const files = await resolveSiblingDocChangedFiles(c, 'gi-child', 'parent-1');
  assert.deepEqual(files, ['packages/app-switcher/README.md', 'docs/API.md', 'docs/ARCH.md'],
    'объединение по порядку первого вхождения, docs/API.md один раз');
  const call = c.calls.find((q) => SIB_RE.test(q.sql));
  assert.deepEqual(call.params, ['parent-1', 'gi-child'], 'спрашиваем сиблингов fork-группы, исключая себя');
});

test('resolveSiblingDocChangedFiles: нет родителя (не fork-ребёнок) → пустой список, без запроса', async () => {
  const c = fakeClient([]);
  const files = await resolveSiblingDocChangedFiles(c, 'solo', null);
  assert.deepEqual(files, []);
  assert.equal(c.calls.length, 0, 'без parent_task_id к БД не ходим — прежнее поведение');
});

test('resolveSiblingDocChangedFiles: сиблинги без changedFiles (NO_CHANGES) → пустой список', async () => {
  const c = fakeClient([
    { re: SIB_RE, reply: { rowCount: 2, rows: [{ data_card: {} }, { data_card: null }] } },
  ]);
  const files = await resolveSiblingDocChangedFiles(c, 'gi', 'p1');
  assert.deepEqual(files, [], 'без правок доков — пусто (второго коммита не будет)');
});

test('resolveSiblingDocChangedFiles: не-массив changedFiles игнорируется (не падаем)', async () => {
  const c = fakeClient([
    { re: SIB_RE, reply: { rowCount: 1, rows: [{ data_card: { changedFiles: 'oops' } }] } },
  ]);
  const files = await resolveSiblingDocChangedFiles(c, 'gi', 'p1');
  assert.deepEqual(files, []);
});

// --- Канонический набор doc-ролей и живость doc-ветви (DOC-BRANCH-LIVENESS-001) ---

test('DOC_BRANCH_ROLE_CODES: канонический набор doc-ветви', () => {
  assert.deepEqual([...DOC_BRANCH_ROLE_CODES].sort(),
    ['DOCUMENTATION_AUDITOR', 'DOCUMENTATION_KEEPER']);
});

test('decideOutcome: BLOCKED у doc-ролей → FORWARD (docs_blocked_forwarded), не блок', () => {
  // Сохранение DOC-BRANCH-LIVENESS-001: BLOCKED doc-роли уходит вперёд к join, снимая
  // doc-роль → отпускает гейт GI. Не BLOCK — иначе GI ждал бы вечно.
  for (const code of DOC_BRANCH_ROLE_CODES) {
    const d = decideOutcome(code, { ok: false, status: 'BLOCKED' }, {});
    assert.equal(d.outcome, 'FORWARD', `${code}: doc BLOCKED не блокирует поток`);
    assert.equal(d.reason, 'docs_blocked_forwarded');
  }
});

// --- Регрессия на inline-SQL сериализации (claimNextHostTask без БД не вызвать) ---

test('исходник db.js: claim Git Integrator сериализован по doc-сиблингам fork-группы', async () => {
  const src = await readFile(new URL('../src/db.js', import.meta.url), 'utf8');
  assert.match(src, /\$1 <> 'GIT_INTEGRATOR'/, 'гейт бьёт только по GI');
  assert.match(src, /t\.parent_task_id IS NULL/, 'не-fork GI (нет родителя) не гейтится');
  assert.match(src, /sib\.parent_task_id = t\.parent_task_id/, 'сиблинги — по общей fork-группе');
  assert.match(src, /sib\.status NOT IN \('DONE','CANCELLED','FAILED'\)/, 'ждём терминальности doc-сиблинга');
  assert.match(src, /sr\.code = ANY\(\$3::text\[\]\)/, 'фильтр по doc-ролям через параметр');
  assert.match(src, /\[roleCode, role\.from, DOC_BRANCH_ROLE_CODES\]/, 'DOC_BRANCH_ROLE_CODES передан как $3');
});

test('исходник db.js: контекст Git Integrator несёт docChangedFiles', async () => {
  const src = await readFile(new URL('../src/db.js', import.meta.url), 'utf8');
  assert.match(src, /docChangedFiles/, 'проброс doc-changedFiles в контекст GI');
  assert.match(src, /roleCode === 'GIT_INTEGRATOR'\s*\?\s*await resolveSiblingDocChangedFiles/,
    'docChangedFiles считаются только для GI');
});

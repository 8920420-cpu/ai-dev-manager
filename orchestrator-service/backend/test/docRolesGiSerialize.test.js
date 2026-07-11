// DOCROLES-GI-SERIALIZE-001 — сериализация doc-ветви ПОСЛЕ git-ветви одной fork-группы
// сервиса: fork-ребёнок Git Integrator вливает дельту Программиста в ЧИСТОЕ рабочее
// дерево РАНЬШЕ, чем doc-роли (Documentation Auditor/Keeper) начнут писать в него
// README.md/docs/*.md. Гейт стоит на claim doc-роли (claimLlmRoleTask): её не выдают,
// пока git-сиблинг той же fork-группы нетерминален и стоит на GIT_INTEGRATOR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DOC_BRANCH_ROLE_CODES, decideOutcome } from '../src/roleEngine.js';

// --- Канонический набор doc-ролей и живость doc-ветви (DOC-BRANCH-LIVENESS-001) ---

test('DOC_BRANCH_ROLE_CODES: канонический набор doc-ветви', () => {
  assert.deepEqual([...DOC_BRANCH_ROLE_CODES].sort(),
    ['DOCUMENTATION_AUDITOR', 'DOCUMENTATION_KEEPER']);
});

test('decideOutcome: BLOCKED у doc-ролей → FORWARD (docs_blocked_forwarded), не блок', () => {
  // Сохранение DOC-BRANCH-LIVENESS-001: BLOCKED doc-роли уходит вперёд к join и не
  // держит родителя. Зависимость doc→GI односторонняя, поэтому основной поток
  // (git-ветвь) doc-ветвь не блокирует, а сама лишь ждёт схода git-ветви с GI.
  for (const code of DOC_BRANCH_ROLE_CODES) {
    const d = decideOutcome(code, { ok: false, status: 'BLOCKED' }, {});
    assert.equal(d.outcome, 'FORWARD', `${code}: doc BLOCKED не блокирует поток`);
    assert.equal(d.reason, 'docs_blocked_forwarded');
  }
});

// --- Регрессия на inline-SQL сериализации (claim без живой БД не вызвать) ----------

test('исходник db.js: claim doc-роли придержан, пока git-сиблинг стоит на GIT_INTEGRATOR', async () => {
  const src = await readFile(new URL('../src/db.js', import.meta.url), 'utf8');
  // Гейт бьёт только по doc-ролям (набор передан параметром).
  assert.match(src, /NOT \(r\.code = ANY\(\$\$\{params\.length\}::text\[\]\)\)/,
    'гейт применяется только к doc-ролям через параметр DOC_BRANCH_ROLE_CODES');
  assert.match(src, /params\.push\(DOC_BRANCH_ROLE_CODES\)/, 'DOC_BRANCH_ROLE_CODES добавлен в params');
  // Не-fork документация (нет родителя) не гейтится.
  assert.match(src, /OR t\.parent_task_id IS NULL/, 'не-fork doc-роль (нет сиблингов) не гейтится');
  // Ждём именно git-сиблинга той же fork-группы на GIT_INTEGRATOR.
  assert.match(src, /sib\.parent_task_id = t\.parent_task_id/, 'сиблинги — по общей fork-группе');
  assert.match(src, /sib\.status NOT IN \('DONE','CANCELLED','FAILED'\)/, 'ждём терминальности git-сиблинга');
  assert.match(src, /sr\.code = 'GIT_INTEGRATOR'/, 'ждём именно git-ветвь (GIT_INTEGRATOR)');
  // Гейт вклеен в выборку claimLlmRoleTask.
  assert.match(src, /\)\$\{docSerializeGate\}\s*\n\s*ORDER BY t\.priority ASC, t\.created_at ASC/,
    'docSerializeGate вклеен перед ORDER BY выборки claimLlmRoleTask');
});

test('исходник db.js: прежний гейт fork-ребёнка Git Integrator и проброс docChangedFiles сняты', async () => {
  const src = await readFile(new URL('../src/db.js', import.meta.url), 'utf8');
  // Направление сериализации перевёрнуто: GI больше НЕ ждёт doc-ветвь (иначе он всё
  // равно упирался бы в незакоммиченную doc-правку — host-runner её не коммитит).
  assert.doesNotMatch(src, /\$1 <> 'GIT_INTEGRATOR'/, 'старый гейт на claim GI удалён');
  // Мёртвый проброс (host-runner GI это поле не читал) убран.
  assert.doesNotMatch(src, /docChangedFiles/, 'мёртвый docChangedFiles убран из контекста GI');
  assert.doesNotMatch(src, /resolveSiblingDocChangedFiles/, 'ненужный хелпер удалён');
});

test('исходник db.js: агрегация changedFiles doc-детей в событии join сохранена (контракт коммита доков)', async () => {
  // DOC-COMMIT-ON-JOIN-001: changedFiles doc-детей по-прежнему собираются в событие
  // продвижения родителя за join — это контракт, по которому Git Integrator коммитит
  // doc-дельту (resolveHostTaskContext читает их по цепочке). Не теряем при перестановке.
  const src = await readFile(new URL('../src/db.js', import.meta.url), 'utf8');
  assert.match(src, /if \(childChanged\.length\) joinPayload\.changedFiles = childChanged/,
    'changedFiles doc-детей выносятся в событие join');
});

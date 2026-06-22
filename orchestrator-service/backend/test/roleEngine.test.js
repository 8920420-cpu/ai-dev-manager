import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVerdict,
  normalizeVerdict,
  decideTransition,
  buildVerdictInstruction,
  buildUserPayload,
  loadRolePrompt,
  summarizePriorRuns,
  ROLE_PROMPT_FILES,
} from '../src/roleEngine.js';

test('parseVerdict: чистый JSON', () => {
  assert.deepEqual(parseVerdict('{"status":"APPROVED"}'), { status: 'APPROVED' });
});

test('parseVerdict: JSON в ```-блоке', () => {
  const v = parseVerdict('текст\n```json\n{"status":"READY"}\n```\nхвост');
  assert.deepEqual(v, { status: 'READY' });
});

test('parseVerdict: JSON с мусором вокруг', () => {
  const v = parseVerdict('Вот результат: {"status":"DONE","summary":"ok"} конец');
  assert.deepEqual(v, { status: 'DONE', summary: 'ok' });
});

test('parseVerdict: не-объект и мусор => null', () => {
  assert.equal(parseVerdict('просто текст'), null);
  assert.equal(parseVerdict('[1,2,3]'), null);
  assert.equal(parseVerdict(''), null);
});

test('normalizeVerdict: успех/провал/неизвестно', () => {
  assert.equal(normalizeVerdict('TASK_REVIEWER', { status: 'APPROVED' }).ok, true);
  assert.equal(normalizeVerdict('TASK_REVIEWER', { status: 'NEEDS_FIX' }).ok, false);
  assert.equal(normalizeVerdict('TASK_REVIEWER', { status: 'WAT' }).ok, null);
  assert.equal(normalizeVerdict('TASK_REVIEWER', null).ok, null);
});

test('normalizeVerdict: собирает summary/next/findings', () => {
  const v = normalizeVerdict('ARCHITECT', {
    status: 'ready',
    summary: 'план',
    next_role: 'decomposer',
    findings: ['a', { b: 1 }],
  });
  assert.equal(v.status, 'READY');
  assert.equal(v.ok, true);
  assert.equal(v.summary, 'план');
  assert.equal(v.nextRoleHint, 'DECOMPOSER');
  assert.deepEqual(v.findings, ['a', '{"b":1}']);
});

test('decideTransition: TASK_REVIEWER APPROVED => TESTING/PIPELINE_SERVICE', () => {
  const d = decideTransition('TASK_REVIEWER', { ok: true, status: 'APPROVED' });
  assert.equal(d.toStatus, 'TESTING');
  assert.equal(d.nextRole, 'PIPELINE_SERVICE');
  assert.equal(d.blocked, false);
  assert.equal(d.agentRunStatus, 'SUCCESS');
});

test('decideTransition: TASK_REVIEWER NEEDS_FIX => FAILURE_ANALYSIS/FAILURE_ANALYST', () => {
  const d = decideTransition('TASK_REVIEWER', { ok: false, status: 'NEEDS_FIX' }, { reworkCount: 0 });
  assert.equal(d.toStatus, 'FAILURE_ANALYSIS');
  assert.equal(d.nextRole, 'FAILURE_ANALYST');
  assert.equal(d.blocked, false);
});

test('decideTransition: TASK_REVIEWER неразобранный вердикт не апрувит', () => {
  const d = decideTransition('TASK_REVIEWER', { ok: null, status: '' }, { reworkCount: 0 });
  assert.equal(d.nextRole, 'FAILURE_ANALYST');
});

test('decideTransition: защита от цикла — max rework => BLOCKED', () => {
  const d = decideTransition('TASK_REVIEWER', { ok: false, status: 'NEEDS_FIX' }, { reworkCount: 3, maxRework: 3 });
  assert.equal(d.blocked, true);
  assert.equal(d.toStatus, 'BLOCKED');
  assert.equal(d.reason, 'max_rework_exceeded');
});

test('decideTransition: FAILURE_ANALYST DIAGNOSED => CODING/PROGRAMMER', () => {
  const d = decideTransition('FAILURE_ANALYST', { ok: true, status: 'DIAGNOSED' }, { reworkCount: 1 });
  assert.equal(d.toStatus, 'CODING');
  assert.equal(d.nextRole, 'PROGRAMMER');
});

test('decideTransition: FAILURE_ANALYST INFRASTRUCTURE_BLOCKED => BLOCKED', () => {
  const d = decideTransition('FAILURE_ANALYST', { ok: false, status: 'INFRASTRUCTURE_BLOCKED' });
  assert.equal(d.blocked, true);
});

test('decideTransition: ARCHITECT BLOCKED => BLOCKED, READY => DECOMPOSITION', () => {
  assert.equal(decideTransition('ARCHITECT', { ok: false, status: 'BLOCKED' }).blocked, true);
  const ok = decideTransition('ARCHITECT', { ok: true, status: 'READY' });
  assert.equal(ok.toStatus, 'DECOMPOSITION');
  assert.equal(ok.nextRole, 'DECOMPOSER');
});

test('decideTransition: GIT_INTEGRATOR success => DONE (done=true)', () => {
  const d = decideTransition('GIT_INTEGRATOR', { ok: true, status: 'DONE' });
  assert.equal(d.toStatus, 'DONE');
  assert.equal(d.nextRole, null);
  assert.equal(d.done, true);
});

test('buildVerdictInstruction/buildUserPayload содержат JSON-контракт и контекст', () => {
  assert.match(buildVerdictInstruction(), /JSON/);
  const payload = buildUserPayload('TASK_REVIEWER', { taskId: 'x', title: 'T' });
  assert.match(payload, /TASK_REVIEWER/);
  assert.match(payload, /"title": "T"/);
});

test('loadRolePrompt читает реальный промт роли', async () => {
  const text = await loadRolePrompt('TASK_REVIEWER');
  assert.match(text, /Task Reviewer/);
});

test('summarizePriorRuns: компактный список из agent_runs', () => {
  const out = summarizePriorRuns([
    { role_code: 'ARCHITECT', status: 'SUCCESS', output_json: { status: 'READY', summary: 'дизайн', findings: ['a', 'b'] } },
    { role_code: 'DECOMPOSER', status: 'SUCCESS', output_json: { status: 'READY', summary: 'разбивка' } },
    { role_code: null, output_json: {} },
  ]);
  assert.deepEqual(out, [
    { role: 'ARCHITECT', status: 'READY', summary: 'дизайн', findings: ['a', 'b'] },
    { role: 'DECOMPOSER', status: 'READY', summary: 'разбивка', findings: [] },
  ]);
});

test('summarizePriorRuns: пустой и без output_json', () => {
  assert.deepEqual(summarizePriorRuns([]), []);
  assert.deepEqual(summarizePriorRuns([{ role_code: 'X', status: 'SUCCESS' }]), [
    { role: 'X', status: 'SUCCESS', summary: '', findings: [] },
  ]);
});

test('ROLE_PROMPT_FILES покрывает 6 рассуждающих ролей', () => {
  assert.deepEqual(Object.keys(ROLE_PROMPT_FILES).sort(), [
    'ARCHITECT', 'DECOMPOSER', 'DOCUMENTATION_AUDITOR',
    'DOCUMENTATION_KEEPER', 'FAILURE_ANALYST', 'TASK_REVIEWER',
  ]);
});

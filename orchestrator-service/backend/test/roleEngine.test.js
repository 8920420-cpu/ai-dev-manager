import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVerdict,
  parseYamlVerdict,
  normalizeVerdict,
  decideTransition,
  decideOutcome,
  buildVerdictInstruction,
  buildUserPayload,
  renderProjectMaps,
  summarizePriorRuns,
  LLM_ROLE_CODES,
  capToolArgs,
  compactToolResult,
  pickAssignedConnectorRow,
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

// VERDICT-PARSE-ROBUST-001 — устойчивость к почти-валидному JSON, ронявшему verdict_unparsed.
test('parseVerdict: висячая запятая перед }', () => {
  assert.deepEqual(
    parseVerdict('{"status":"READY","summary":"ok",}'),
    { status: 'READY', summary: 'ok' },
  );
});

test('parseVerdict: проза с фигурными скобками до финального JSON', () => {
  const v = parseVerdict('Сначала черновик {набросок}. Итоговый вердикт: {"status":"READY"}.');
  assert.deepEqual(v, { status: 'READY' });
});

test('parseVerdict: несколько объектов — берём последний со status', () => {
  const v = parseVerdict('{"note":"промежуточно"}\n{"status":"BLOCKED","summary":"s"}');
  assert.deepEqual(v, { status: 'BLOCKED', summary: 's' });
});

test('parseVerdict: вложенный fields сохраняется', () => {
  const v = parseVerdict('бла {"status":"READY","fields":{"short_title":"T","tags":["a","b"]}} бла');
  assert.deepEqual(v, { status: 'READY', fields: { short_title: 'T', tags: ['a', 'b'] } });
});

test('parseVerdict: ```-блок среди прозы с другими скобками', () => {
  const v = parseVerdict('Мысли: {x}\n```json\n{"status":"APPROVED"}\n```\nещё {y}');
  assert.deepEqual(v, { status: 'APPROVED' });
});

// VERDICT-YAML-FENCE-001 — вердикт в ```yaml-фенсе (claude_code без --output-schema)
// должен распознаваться в тот же объект-вердикт, а не ронять verdict_unparsed.
test('parseVerdict: вердикт в ```yaml-фенсе → объект-вердикт', () => {
  const text = [
    'Вот мой вывод:',
    '```yaml',
    'status: APPROVED',
    'summary: Всё соответствует требованиям',
    'findings:',
    '  - замечание один',
    '  - замечание два',
    '```',
  ].join('\n');
  assert.deepEqual(parseVerdict(text), {
    status: 'APPROVED',
    summary: 'Всё соответствует требованиям',
    findings: ['замечание один', 'замечание два'],
  });
});

test('parseVerdict: ```yml-фенс с вложенным fields (маппинг + список)', () => {
  const text = [
    '```yml',
    'status: READY',
    'summary: ok',
    'fields:',
    '  short_title: Заголовок',
    '  tags:',
    '    - a',
    '    - b',
    '```',
  ].join('\n');
  assert.deepEqual(parseVerdict(text), {
    status: 'READY',
    summary: 'ok',
    fields: { short_title: 'Заголовок', tags: ['a', 'b'] },
  });
});

test('parseYamlVerdict: без ключа status → null (прозу в YAML не принимаем за вердикт)', () => {
  assert.equal(parseYamlVerdict('summary: просто текст\nnote: без статуса'), null);
  assert.equal(parseYamlVerdict('просто строка без структуры'), null);
  assert.equal(parseYamlVerdict(''), null);
});

test('parseYamlVerdict: кавычки и инлайн-список', () => {
  assert.deepEqual(
    parseYamlVerdict('status: "NEEDS_FIX"\nfindings: [первое, "второе"]'),
    { status: 'NEEDS_FIX', findings: ['первое', 'второе'] },
  );
});

// ```yaml-фенс без status — НЕ вердикт: parseVerdict должен вернуть null (verdict_unparsed
// с последующим авто-ретраем), а не выдумать частичный вердикт.
test('parseVerdict: ```yaml без status → null', () => {
  assert.equal(parseVerdict('```yaml\nsummary: пояснение без статуса\n```'), null);
});

// SILENT-FAIL-GUARD-001 (B): ответ DeepSeek с tool-call разметкой DSML (без финального
// JSON) НЕ должен распознаваться как вердикт → parsed=null → роль помечается «не выполнен».
test('parseVerdict: DeepSeek DSML tool-calls без JSON => null (триггер failRoleUnparsed)', () => {
  const dsml = [
    '<｜｜DSML｜｜tool_calls>',
    '<｜｜DSML｜｜invoke name="read_file">',
    '<｜｜DSML｜｜parameter name="path" string="true">src/types/settings.ts</｜｜DSML｜｜parameter>',
    '</｜｜DSML｜｜invoke>',
    '</｜｜DSML｜｜tool_calls>',
  ].join('\n');
  assert.equal(parseVerdict(dsml), null);
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

test('decideTransition: TASK_REVIEWER NEEDS_FIX => CODING/PROGRAMMER', () => {
  const d = decideTransition('TASK_REVIEWER', { ok: false, status: 'NEEDS_FIX' }, { reworkCount: 0 });
  assert.equal(d.toStatus, 'CODING');
  assert.equal(d.nextRole, 'PROGRAMMER');
  assert.equal(d.blocked, false);
});

test('decideTransition: TASK_REVIEWER неразобранный вердикт не апрувит', () => {
  const d = decideTransition('TASK_REVIEWER', { ok: null, status: '' }, { reworkCount: 0 });
  assert.equal(d.nextRole, 'PROGRAMMER');
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

test('decideTransition: ARCHITECT BLOCKED => BLOCKED, READY => CODING (Programmer)', () => {
  assert.equal(decideTransition('ARCHITECT', { ok: false, status: 'BLOCKED' }).blocked, true);
  const ok = decideTransition('ARCHITECT', { ok: true, status: 'READY' });
  assert.equal(ok.toStatus, 'CODING');
  assert.equal(ok.nextRole, 'PROGRAMMER');
});

test('decideTransition: DOCUMENTATION_AUDITOR UPDATE_REQUIRED => DOCUMENTATION_KEEPER', () => {
  const d = decideTransition('DOCUMENTATION_AUDITOR', { ok: null, status: 'UPDATE_REQUIRED' });
  assert.equal(d.toStatus, 'COMMIT');
  assert.equal(d.nextRole, 'DOCUMENTATION_KEEPER');
  assert.equal(d.blocked, false);
  assert.equal(d.agentRunStatus, 'SUCCESS');
});

test('decideTransition: DOCUMENTATION_AUDITOR ARCHITECT_REVIEW_REQUIRED => ARCHITECT', () => {
  const d = decideTransition('DOCUMENTATION_AUDITOR', { ok: null, status: 'ARCHITECT_REVIEW_REQUIRED' });
  assert.equal(d.toStatus, 'ARCHITECTURE');
  assert.equal(d.nextRole, 'ARCHITECT');
});

test('decideTransition: DOCUMENTATION_AUDITOR NO_CHANGES => GIT_INTEGRATOR', () => {
  const d = decideTransition('DOCUMENTATION_AUDITOR', { ok: null, status: 'NO_CHANGES' });
  assert.equal(d.toStatus, 'COMMIT');
  assert.equal(d.nextRole, 'GIT_INTEGRATOR');
});

// DOC-BRANCH-LIVENESS-001: документация НЕ блокирует основной поток. BLOCKED-вердикт
// документационной роли не оставляет задачу в BLOCKED, а ведёт её вперёд по маршруту
// (иначе параллельная документационная fork-ветвь держит join и родителя вечно).
test('decideTransition: DOCUMENTATION_AUDITOR BLOCKED => forward (не BLOCKED)', () => {
  const d = decideTransition('DOCUMENTATION_AUDITOR', { ok: false, status: 'BLOCKED' });
  assert.equal(d.blocked, false, 'документация не блокирует основной поток');
  assert.equal(d.toStatus, 'COMMIT');
  assert.equal(d.nextRole, 'GIT_INTEGRATOR');
  assert.equal(d.agentRunStatus, 'SUCCESS');
  assert.equal(d.reason, 'docs_blocked_forwarded');
});

test('decideTransition: DOCUMENTATION_KEEPER BLOCKED => forward (не BLOCKED)', () => {
  const d = decideTransition('DOCUMENTATION_KEEPER', { ok: false, status: 'BLOCKED' });
  assert.equal(d.blocked, false);
  assert.equal(d.nextRole, 'GIT_INTEGRATOR');
  assert.equal(d.reason, 'docs_blocked_forwarded');
});

test('decideOutcome (граф): документация BLOCKED => FORWARD, а не BLOCK', () => {
  const a = decideOutcome('DOCUMENTATION_AUDITOR', { ok: false, status: 'BLOCKED' });
  assert.equal(a.outcome, 'FORWARD', 'аудитор не блокирует ветку');
  assert.equal(a.agentRunStatus, 'SUCCESS');
  assert.equal(a.reason, 'docs_blocked_forwarded');
  const k = decideOutcome('DOCUMENTATION_KEEPER', { ok: false, status: 'BLOCKED' });
  assert.equal(k.outcome, 'FORWARD', 'keeper не блокирует ветку');
  assert.equal(k.reason, 'docs_blocked_forwarded');
});

test('decideOutcome (граф): документация UPDATE_REQUIRED => BRANCH к Keeper (не тронуто)', () => {
  const a = decideOutcome('DOCUMENTATION_AUDITOR', { ok: null, status: 'UPDATE_REQUIRED' });
  assert.equal(a.outcome, 'BRANCH');
  assert.equal(a.branchRole, 'DOCUMENTATION_KEEPER');
});

test('decideTransition: DOCUMENTATION_KEEPER UPDATED => GIT_INTEGRATOR', () => {
  const d = decideTransition('DOCUMENTATION_KEEPER', { ok: true, status: 'UPDATED' });
  assert.equal(d.toStatus, 'COMMIT');
  assert.equal(d.nextRole, 'GIT_INTEGRATOR');
});

test('decideTransition: GIT_INTEGRATOR success => DONE (done=true)', () => {
  const d = decideTransition('GIT_INTEGRATOR', { ok: true, status: 'DONE' });
  assert.equal(d.toStatus, 'DONE');
  assert.equal(d.nextRole, null);
  assert.equal(d.done, true);
});

test('buildVerdictInstruction/buildUserPayload содержат JSON-контракт и контекст', () => {
  const instruction = buildVerdictInstruction();
  assert.match(instruction, /JSON/);
  // VERDICT-YAML-FENCE-001: контракт явно запрещает код-фенсы и YAML вокруг вердикта.
  assert.match(instruction, /код-фенс/);
  assert.match(instruction, /YAML/);
  const payload = buildUserPayload('TASK_REVIEWER', { taskId: 'x', title: 'T' });
  assert.match(payload, /TASK_REVIEWER/);
  // Контекст сериализуется компактно (без отступов) — экономия токенов.
  assert.match(payload, /"title":"T"/);
});

// --- RESEARCH-BUDGET-001: карта проекта инлайн ------------------------------

test('renderProjectMaps: проект + сервис → markdown-блок; пусто → пустая строка', () => {
  assert.equal(renderProjectMaps(null), '');
  assert.equal(renderProjectMaps({}), '');
  const block = renderProjectMaps({ project: 'P-MAP', service: 'S-MAP', serviceName: 'scanner' });
  assert.match(block, /Карта проекта/);
  assert.match(block, /P-MAP/);
  assert.match(block, /Карта микросервиса scanner/);
  assert.match(block, /S-MAP/);
});

test('buildUserPayload: projectMaps рендерится инлайн и НЕ попадает в JSON-контекст', () => {
  const payload = buildUserPayload('ARCHITECT', {
    taskId: 'x', title: 'T', projectMaps: { project: 'PROJECT-MAP-TEXT', serviceName: '' },
  });
  // Карта — отдельным markdown-блоком до контекста.
  assert.match(payload, /Карта проекта/);
  assert.match(payload, /PROJECT-MAP-TEXT/);
  assert.match(payload, /"title":"T"/);
  // Карта не должна дублироваться внутри JSON-контекста.
  assert.ok(!/"projectMaps"/.test(payload));
});

// PROMPT-CACHE-001: includeMap=false исключает карту из user-payload (её выносят в
// кэшируемый system-префикс для claude_code).
test('buildUserPayload: includeMap=false не кладёт карту в payload', () => {
  const ctx = { taskId: 'x', title: 'T', projectMaps: { project: 'PROJECT-MAP-TEXT', serviceName: '' } };
  const withMap = buildUserPayload('ARCHITECT', ctx, [], { includeMap: true });
  assert.match(withMap, /PROJECT-MAP-TEXT/);
  const noMap = buildUserPayload('ARCHITECT', ctx, [], { includeMap: false });
  assert.ok(!/PROJECT-MAP-TEXT/.test(noMap));
  assert.ok(!/Карта проекта/.test(noMap));
  // Контекст задачи при этом сохраняется.
  assert.match(noMap, /"title":"T"/);
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

test('summarizePriorRuns: длинные summary/findings усечены с маркером, короткие как есть', () => {
  const longSummary = 'с'.repeat(1000);
  const longFinding = 'ф'.repeat(500);
  const [out] = summarizePriorRuns([
    {
      role_code: 'ARCHITECT',
      output_json: { status: 'READY', summary: longSummary, findings: [longFinding, 'коротко'] },
    },
  ]);
  // summary усечён ровно до капа (700), последний символ — маркер усечения.
  assert.equal(out.summary.length, 700);
  assert.ok(out.summary.endsWith('…'));
  assert.equal(out.summary.slice(0, -1), 'с'.repeat(699));
  // Длинный элемент findings усечён до капа (300) с маркером, короткий — без изменений.
  assert.equal(out.findings[0].length, 300);
  assert.ok(out.findings[0].endsWith('…'));
  assert.equal(out.findings[1], 'коротко');
});

test('summarizePriorRuns: значения на границе капа проходят без маркера', () => {
  const exactSummary = 'a'.repeat(700);
  const exactFinding = 'b'.repeat(300);
  const [out] = summarizePriorRuns([
    { role_code: 'ARCHITECT', output_json: { summary: exactSummary, findings: [exactFinding] } },
  ]);
  assert.equal(out.summary, exactSummary);
  assert.ok(!out.summary.endsWith('…'));
  assert.equal(out.findings[0], exactFinding);
  assert.ok(!out.findings[0].endsWith('…'));
});

test('parseTextToolCalls: разбирает текстовый вызов инструмента (DeepSeek DSML)', async () => {
  const { parseTextToolCalls } = await import('../src/roleEngine.js');
  const content = [
    'Посмотрю карту API.',
    '<｜｜DSML｜｜tool_calls>',
    '<｜｜DSML｜｜invoke name="read_file">',
    '<｜｜DSML｜｜parameter name="path" string="true">docs/API_MAP.md</｜｜DSML｜｜parameter>',
    '</｜｜DSML｜｜invoke>',
    '</｜｜DSML｜｜tool_calls>',
  ].join('\n');
  const calls = parseTextToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.equal(calls[0].args.path, 'docs/API_MAP.md');
});

test('parseTextToolCalls: нет вызовов → пустой массив', async () => {
  const { parseTextToolCalls } = await import('../src/roleEngine.js');
  assert.deepEqual(parseTextToolCalls('{"status":"READY"}'), []);
});

test('capToolArgs: ограничивает большие tool-запросы до оркестраторских дефолтов', () => {
  assert.deepEqual(capToolArgs('read_file', { path: 'a.js' }), { path: 'a.js', maxBytes: 16000 });
  assert.deepEqual(capToolArgs('read_file', { path: 'a.js', maxBytes: 999999 }), { path: 'a.js', maxBytes: 16000 });
  assert.deepEqual(capToolArgs('search_text', { query: 'x', maxResults: 999 }), { query: 'x', maxResults: 25 });
});

test('compactToolResult: режет длинный результат перед возвратом в LLM-контекст', () => {
  const out = compactToolResult({ content: 'x'.repeat(50) }, { maxChars: 20 });
  const parsed = JSON.parse(out);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.originalChars > 20);
  assert.equal(parsed.content.length, 20);
});

// Регрессия: JSON.stringify(undefined) === undefined (не строка). Раньше text.length
// падал TypeError, и внешний catch подменял успешный вызов инструмента фейковой
// ошибкой. Теперь undefined-результат → пустая строка без падения.
test('compactToolResult: undefined-результат инструмента → пустая строка, не падение', () => {
  assert.equal(compactToolResult(undefined), '');
  assert.equal(compactToolResult({ ok: true, result: undefined }.result), '');
});

test('LLM_ROLE_CODES покрывает 7 рассуждающих ролей (вкл. Приёмщика задач)', () => {
  assert.deepEqual([...LLM_ROLE_CODES].sort(), [
    'ARCHITECT', 'DECOMPOSER', 'DOCUMENTATION_AUDITOR',
    'DOCUMENTATION_KEEPER', 'FAILURE_ANALYST', 'TASK_INTAKE_OFFICER', 'TASK_REVIEWER',
  ]);
});

test('pickAssignedConnectorRow: deterministic ORDER BY for multiple role connectors', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
  await pickAssignedConnectorRow(client, 'ARCHITECT');
  assert.match(calls[0].sql, /ORDER BY cn\.priority ASC, lower\(cn\.name\) ASC, cn\.id ASC/);
  assert.deepEqual(calls[0].params, ['ARCHITECT']);
});

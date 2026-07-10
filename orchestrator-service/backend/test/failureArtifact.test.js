// FA-MISSING-ARTIFACT-001 — артефакт провала host-роли в контексте Аналитика сбоя и
// анти-петля «нет артефакта». Инцидент (задачи 1c3967ab/1ff73c5a): PIPELINE_SERVICE
// падал с pipeline_compose_not_found в output_json, но FADC не видел причину (в
// контекст шли только SUCCESS-прогоны) и 4 раунда просил «реальный лог» → BLOCKED.
// Мини-клиент pg (как в priorOutputsDedup.test.js): отвечает по первому regex-правилу.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFailureArtifact, fetchFailureArtifact } from '../src/db.js';
import { isMissingArtifactComplaint, decideOutcome } from '../src/roleEngine.js';

function fakeClient(rules = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const rule of rules) {
        if (rule.re.test(sql)) return rule.reply ?? { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const FAIL_ARTIFACT_RE = /FROM agent_runs ar JOIN roles r[\s\S]*ar\.status = 'FAILED'/;

// ── summarizeFailureArtifact: провал pipeline с error БЕЗ runId (ошибка ДО команд) ──
test('summarizeFailureArtifact: провал pipeline с error без runId → code/message/failedStage', () => {
  // Инцидентная форма output_json: error на ВЕРХНЕМ уровне, команды не стартовали.
  const output = {
    error: { code: 'pipeline_compose_not_found', message: 'Не найден docker-compose.yml вверх от каталога сервиса orchestrator-service' },
    failedStage: 'deploy',
  };

  const art = summarizeFailureArtifact('PIPELINE_SERVICE', output);

  assert.equal(art.role, 'PIPELINE_SERVICE');
  assert.equal(art.status, 'FAILED');
  assert.equal(art.errorCode, 'pipeline_compose_not_found', 'error.code извлечён');
  assert.match(art.errorMessage, /Не найден docker-compose\.yml/, 'error.message извлечён');
  assert.equal(art.failedStage, 'deploy', 'failedStage извлечён');
  // Ошибка ДО запуска команд: хвоста лога и упавшей команды нет — причина в message.
  assert.equal(art.logTail, '', 'logTail пустой при ошибке до команд');
  assert.equal(art.failedCommand, null, 'упавшей команды нет');
  assert.equal(art.runId, null, 'runId отсутствует');
});

// ── summarizeFailureArtifact: провал pipeline С ЛОГОМ (упавшая команда + хвост) ──
test('summarizeFailureArtifact: провал pipeline с логом → хвост лога и упавшая команда', () => {
  // Форма от pipeline-runner: error в summary.error (+ logTail), actions с exit code.
  const output = {
    summary: {
      status: 'failed',
      runId: 'run-777',
      error: {
        code: 'pipeline_stage_failed',
        message: 'Стадия "test" провалилась, команда: npm test, exit=1',
        logTail: 'FAIL src/foo.test.js\n  ✕ падает (5 ms)',
      },
      actions: [
        { stage: 'build', name: 'build', command: 'npm ci', status: 'success', exitCode: 0 },
        { stage: 'test', name: 'test', command: 'npm test', status: 'failed', exitCode: 1, logFragment: 'FAIL src/foo.test.js' },
      ],
    },
    failedStage: 'test',
    logPath: '/reports/run-777.json',
  };

  const art = summarizeFailureArtifact('PIPELINE_SERVICE', output);

  assert.equal(art.errorCode, 'pipeline_stage_failed');
  assert.equal(art.failedStage, 'test');
  assert.match(art.logTail, /FAIL src\/foo\.test\.js/, 'хвост лога из summary.error.logTail');
  assert.deepEqual(art.failedCommand, { command: 'npm test', exitCode: 1 }, 'упавшая команда с exit code');
  assert.equal(art.runId, 'run-777', 'runId из summary');
  assert.equal(art.logPath, '/reports/run-777.json', 'logPath проброшен');
});

// ── summarizeFailureArtifact: хвост лога берётся из logFragment, если нет error.logTail ──
test('summarizeFailureArtifact: без error.logTail хвост берётся из logFragment упавшей команды', () => {
  const output = {
    summary: {
      status: 'failed',
      error: { code: 'pipeline_stage_failed', message: 'Стадия "lint" провалилась' },
      actions: [
        { stage: 'lint', name: 'lint', command: 'eslint .', status: 'failed', exitCode: 2, logFragment: 'error  Unexpected token' },
      ],
    },
    failedStage: 'lint',
  };

  const art = summarizeFailureArtifact('PIPELINE_SERVICE', output);
  assert.match(art.logTail, /Unexpected token/, 'хвост лога из logFragment упавшей команды');
  assert.deepEqual(art.failedCommand, { command: 'eslint .', exitCode: 2 });
});

// ── summarizeFailureArtifact: GIT_INTEGRATOR — error-строка и note в контекст ──
test('summarizeFailureArtifact: провал GIT_INTEGRATOR → error-строка в errorMessage', () => {
  const output = { error: 'commit failed: nothing to commit, working tree clean', files: [] };
  const art = summarizeFailureArtifact('GIT_INTEGRATOR', output);
  assert.equal(art.role, 'GIT_INTEGRATOR');
  assert.match(art.errorMessage, /commit failed/, 'строковый error → errorMessage');
  assert.equal(art.errorCode, null, 'у строкового error нет кода');
});

// ── fetchFailureArtifact: берёт ПОСЛЕДНИЙ FAILED host-прогон и сжимает его ──
test('fetchFailureArtifact: последний FAILED host-прогон → артефакт', async () => {
  const c = fakeClient([
    {
      re: FAIL_ARTIFACT_RE,
      reply: {
        rowCount: 1,
        rows: [{
          role_code: 'PIPELINE_SERVICE',
          output_json: { error: { code: 'pipeline_compose_not_found', message: 'нет compose' }, failedStage: 'deploy' },
        }],
      },
    },
  ]);

  const art = await fetchFailureArtifact(c, 'task-1');

  assert.ok(art, 'артефакт получен');
  assert.equal(art.errorCode, 'pipeline_compose_not_found');
  assert.equal(art.failedStage, 'deploy');
  const q = c.calls.find((x) => FAIL_ARTIFACT_RE.test(x.sql));
  assert.ok(q, 'запрос провального прогона вызван');
  // Границы выборки: только FAILED, только host-роли, последний по времени.
  assert.match(q.sql, /ar\.status = 'FAILED'/, 'только FAILED-прогоны');
  assert.match(q.sql, /IN \('PIPELINE_SERVICE', 'GIT_INTEGRATOR'\)/, 'только host-роли');
  assert.match(q.sql, /ORDER BY ar\.started_at DESC LIMIT 1/, 'последний провал');
  assert.deepEqual(q.params, ['task-1'], 'параметр — task_id');
});

test('fetchFailureArtifact: нет провальных прогонов → null', async () => {
  const c = fakeClient([{ re: FAIL_ARTIFACT_RE, reply: { rows: [], rowCount: 0 } }]);
  const art = await fetchFailureArtifact(c, 'task-2');
  assert.equal(art, null);
});

// ── isMissingArtifactComplaint: инцидентная жалоба vs нормальный диагноз ──
test('isMissingArtifactComplaint: жалоба «нет артефакта провала» → true', () => {
  const verdict = {
    summary: 'В контексте отсутствует артефакт провала: нет упавшей команды, кода возврата и строк лога.',
    findings: ['Нужен реальный лог прогона.'],
  };
  assert.equal(isMissingArtifactComplaint(verdict), true);
});

test('isMissingArtifactComplaint: содержательный диагноз по существу → false', () => {
  const verdict = {
    summary: 'Стадия deploy упала: не найден docker-compose.yml. Причина — не задан каталог сервиса.',
    findings: ['Указать рабочий каталог сервиса в pipeline.'],
  };
  assert.equal(isMissingArtifactComplaint(verdict), false, 'диагноз по существу не считается жалобой');
});

test('isMissingArtifactComplaint: пустой вердикт → false', () => {
  assert.equal(isMissingArtifactComplaint({}), false);
  assert.equal(isMissingArtifactComplaint({ summary: '', findings: [] }), false);
});

// ── decideOutcome (анти-петля): две жалобы подряд → BLOCKED (missing_artifact) ──
test('decideOutcome FA: повтор жалобы «нет артефакта» (priorMissingArtifact) → BLOCK missing_artifact', () => {
  const verdict = { ok: true, status: 'DIAGNOSED', summary: 'Артефакт провала отсутствует: нет лога и кода возврата.', findings: [] };
  const d = decideOutcome('FAILURE_ANALYST', verdict, { reworkCount: 1, priorMissingArtifact: true });
  assert.equal(d.outcome, 'BLOCK');
  assert.equal(d.blockStatus, 'BLOCKED');
  assert.equal(d.reason, 'missing_artifact');
});

test('decideOutcome FA: одна жалоба (без прошлой) → REWORK diagnosed, петли ещё нет', () => {
  const verdict = { ok: true, status: 'DIAGNOSED', summary: 'Артефакт провала отсутствует: нет лога.', findings: [] };
  const d = decideOutcome('FAILURE_ANALYST', verdict, { reworkCount: 0, priorMissingArtifact: false });
  assert.equal(d.outcome, 'REWORK');
  assert.equal(d.reason, 'diagnosed');
});

test('decideOutcome FA: содержательный диагноз даже при priorMissingArtifact → REWORK (не блок)', () => {
  // Прошлый раунд жаловался, но текущий — диагноз по существу: петли нет, работаем.
  const verdict = { ok: true, status: 'DIAGNOSED', summary: 'Не задан каталог сервиса — исправить pipeline.', findings: [] };
  const d = decideOutcome('FAILURE_ANALYST', verdict, { reworkCount: 1, priorMissingArtifact: true });
  assert.equal(d.outcome, 'REWORK');
  assert.equal(d.reason, 'diagnosed');
});

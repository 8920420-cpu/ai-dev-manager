// TASK-NEEDS-INPUT-001 — вопрос исполнителя к человеку и ответ на него.
// Мини-клиент pg (как в taskMutations.test.js): отвечает по первому regex-правилу.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceTaskTx, answerTaskQuestionTx, getNeedsInputBoardTx, requestTaskInputTx,
} from '../src/db.js';

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

/** Задача в CODING, открытых вопросов нет. */
const taskInCoding = (over = {}) => ({
  re: /SELECT id, status::text AS status, needs_input_from_status/,
  reply: {
    rowCount: 1,
    rows: [{
      id: 't1', status: 'CODING', from_status: null, current_role_id: 'rProg',
      description: 'Исходное описание', ...over,
    }],
  },
});

const noOpenQuestion = { re: /SELECT id FROM task_questions WHERE task_id = \$1 AND answered_at IS NULL/, reply: { rowCount: 0, rows: [] } };
const insertQuestion = { re: /INSERT INTO task_questions/, reply: { rowCount: 1, rows: [{ id: 'q1' }] } };

// --- парковка задачи на вопросе ---------------------------------------------

test('requestTaskInput: задача паркуется в NEEDS_INPUT, захват снимается, прежний статус запоминается', async () => {
  const c = fakeClient([taskInCoding(), noOpenQuestion, insertQuestion]);

  const res = await requestTaskInputTx(c, 't1', {
    question: 'Какой БД пользоваться для отчётов?',
    options: ['PostgreSQL', 'ClickHouse'],
    context: 'В репозитории есть оба клиента',
    roleCode: 'PROGRAMMER',
  });

  assert.deepEqual(res, {
    parked: true, duplicate: false, taskId: 't1', questionId: 'q1', fromStatus: 'CODING',
  });

  const upd = c.calls.find((x) => /UPDATE tasks[\s\S]*SET status = 'NEEDS_INPUT'/.test(x.sql));
  assert.ok(upd, 'задача должна переводиться в NEEDS_INPUT');
  // Возврат после ответа возможен только если помним, откуда ушли.
  assert.match(upd.sql, /needs_input_from_status = \$2::task_status/);
  assert.equal(upd.params[1], 'CODING');
  // Слот исполнителя обязан освободиться: иначе задача «занята» и висит вечно.
  assert.match(upd.sql, /assigned_agent_id = NULL/);

  const ev = c.calls.find((x) => /INSERT INTO task_events/.test(x.sql));
  assert.ok(ev, 'переход должен попасть в историю задачи');
  const payload = JSON.parse(ev.params[3]);
  assert.equal(payload.source, 'needs-input');
  assert.equal(payload.via, 'agent-question');
  assert.equal(payload.questionId, 'q1');
});

test('requestTaskInput: варианты чистятся от пустых и дублей', async () => {
  const c = fakeClient([taskInCoding(), noOpenQuestion, insertQuestion]);
  await requestTaskInputTx(c, 't1', {
    question: 'Что делать?',
    options: ['  Вариант A  ', '', 'Вариант A', 'Вариант B', '   '],
  });
  const ins = c.calls.find((x) => /INSERT INTO task_questions/.test(x.sql));
  assert.deepEqual(JSON.parse(ins.params[3]), ['Вариант A', 'Вариант B']);
});

test('requestTaskInput: повторный вызов при открытом вопросе не плодит второй', async () => {
  const c = fakeClient([
    taskInCoding({ status: 'NEEDS_INPUT', from_status: 'CODING' }),
    { re: /SELECT id FROM task_questions WHERE task_id = \$1 AND answered_at IS NULL/, reply: { rowCount: 1, rows: [{ id: 'qExisting' }] } },
  ]);

  const res = await requestTaskInputTx(c, 't1', { question: 'Тот же вопрос' });

  assert.deepEqual(res, { parked: true, duplicate: true, taskId: 't1', questionId: 'qExisting' });
  assert.ok(!c.calls.some((x) => /INSERT INTO task_questions/.test(x.sql)),
    'повторный запрос раннера (потерянный ответ HTTP) не должен создавать второй вопрос');
});

test('requestTaskInput: пустой вопрос и отсутствие задачи отклоняются', async () => {
  const c = fakeClient([taskInCoding(), noOpenQuestion, insertQuestion]);
  await assert.rejects(() => requestTaskInputTx(c, 't1', { question: '   ' }), /question_required/);
  await assert.rejects(() => requestTaskInputTx(c, '', { question: 'Вопрос' }), /taskId_required/);

  const missing = fakeClient([{ re: /SELECT id, status::text AS status, needs_input_from_status/, reply: { rowCount: 0, rows: [] } }]);
  await assert.rejects(() => requestTaskInputTx(missing, 'nope', { question: 'Вопрос' }), /task_not_found/);
});

test('requestTaskInput: терминальную задачу парковать нельзя', async () => {
  const c = fakeClient([taskInCoding({ status: 'DONE' })]);
  await assert.rejects(() => requestTaskInputTx(c, 't1', { question: 'Вопрос' }), /task_terminal/);
});

// --- ответ человека ----------------------------------------------------------

const taskAwaiting = (over = {}) => ({
  re: /SELECT id, status::text AS status, needs_input_from_status/,
  reply: {
    rowCount: 1,
    rows: [{ id: 't1', status: 'NEEDS_INPUT', from_status: 'CODING', description: 'Исходное описание', ...over }],
  },
});
const openQuestionRow = {
  re: /SELECT id, question, answered_at FROM task_questions/,
  reply: { rowCount: 1, rows: [{ id: 'q1', question: 'Какой БД пользоваться?', answered_at: null }] },
};

test('answerTaskQuestion: вопрос закрывается, задача возвращается на прежнюю стадию', async () => {
  const c = fakeClient([taskAwaiting(), openQuestionRow]);

  const res = await answerTaskQuestionTx(c, 't1', {
    questionId: 'q1', answer: 'ClickHouse', answeredBy: 'user@example.com',
  });

  assert.deepEqual(res, { answered: true, taskId: 't1', questionId: 'q1', resumedStatus: 'CODING' });

  const closed = c.calls.find((x) => /UPDATE task_questions SET answer/.test(x.sql));
  assert.equal(closed.params[1], 'ClickHouse');
  assert.equal(closed.params[2], 'user@example.com');

  const upd = c.calls.find((x) => /UPDATE tasks[\s\S]*SET status = \$2::task_status/.test(x.sql));
  assert.equal(upd.params[1], 'CODING', 'вернуться нужно ровно туда, откуда спросили');
  assert.match(upd.sql, /needs_input_from_status = NULL/);
  assert.match(upd.sql, /assigned_agent_id = NULL/);
});

test('answerTaskQuestion: ответ дописывается в описание — только его увидит исполнитель', async () => {
  const c = fakeClient([taskAwaiting(), openQuestionRow]);
  await answerTaskQuestionTx(c, 't1', { questionId: 'q1', answer: 'ClickHouse' });

  const upd = c.calls.find((x) => /UPDATE tasks[\s\S]*SET status = \$2::task_status/.test(x.sql));
  const description = upd.params[2];
  assert.match(description, /^Исходное описание\n\n## Уточнение от заказчика\n/);
  assert.match(description, /\*\*Вопрос:\*\* Какой БД пользоваться\?/);
  assert.match(description, /\*\*Ответ:\*\* ClickHouse$/);
});

test('answerTaskQuestion: пустой ответ, чужой статус и уже отвеченный вопрос отклоняются', async () => {
  await assert.rejects(
    () => answerTaskQuestionTx(fakeClient([taskAwaiting(), openQuestionRow]), 't1', { answer: '   ' }),
    /answer_required/,
  );

  await assert.rejects(
    () => answerTaskQuestionTx(fakeClient([taskAwaiting({ status: 'CODING' })]), 't1', { answer: 'ок' }),
    /task_not_awaiting_input/,
  );

  const answered = fakeClient([
    taskAwaiting(),
    { re: /SELECT id, question, answered_at FROM task_questions/, reply: { rowCount: 1, rows: [{ id: 'q1', question: 'В?', answered_at: new Date() }] } },
  ]);
  await assert.rejects(() => answerTaskQuestionTx(answered, 't1', { questionId: 'q1', answer: 'ок' }), /question_already_answered/);

  const noQuestion = fakeClient([taskAwaiting(), { re: /SELECT id, question, answered_at FROM task_questions/, reply: { rowCount: 0, rows: [] } }]);
  await assert.rejects(() => answerTaskQuestionTx(noQuestion, 't1', { questionId: 'nope', answer: 'ок' }), /question_not_found/);
});

test('answerTaskQuestion: без запомненного статуса задача уходит в CODING, а не остаётся в парковке', async () => {
  const c = fakeClient([taskAwaiting({ from_status: null }), openQuestionRow]);
  const res = await answerTaskQuestionTx(c, 't1', { questionId: 'q1', answer: 'ок' });
  assert.equal(res.resumedStatus, 'CODING');
});

// --- доска -------------------------------------------------------------------

test('getNeedsInputBoard: отдаёт только задачи с открытым вопросом, в порядке приоритета', async () => {
  const c = fakeClient([{
    re: /FROM tasks t\s+JOIN task_questions q/,
    reply: {
      rowCount: 1,
      rows: [{
        id: 't1', title: 'Отчёты', priority: '1',
        project_id: 'p1', project_name: 'ПС', service_name: 'Chat_Service',
        question_id: 'q1', question: 'Какой БД пользоваться?',
        options: ['PostgreSQL', 'ClickHouse'], context: 'есть оба клиента',
        role_code: 'PROGRAMMER', asked_at: '2026-07-20T10:00:00.000Z',
      }],
    },
  }]);

  const board = await getNeedsInputBoardTx(c);

  assert.equal(board.tasks.length, 1);
  assert.deepEqual(board.tasks[0], {
    id: 't1', title: 'Отчёты', projectId: 'p1', projectName: 'ПС',
    // Приоритет отдаём строкой, как остальные доски (фронтовый справочник
    // taskPriorities работает с кодами '0'..'3').
    serviceCode: 'Chat_Service', priority: '1',
    question: {
      id: 'q1', question: 'Какой БД пользоваться?',
      options: ['PostgreSQL', 'ClickHouse'], context: 'есть оба клиента',
      roleCode: 'PROGRAMMER', askedAt: '2026-07-20T10:00:00.000Z',
    },
  });

  const sql = c.calls[0].sql;
  assert.match(sql, /answered_at IS NULL/, 'отвеченные вопросы на доске не нужны');
  assert.match(sql, /WHERE t\.status = 'NEEDS_INPUT'/);
  assert.match(sql, /ORDER BY t\.priority ASC/);
});

// --- взаимодействие с остальным конвейером -----------------------------------

test('advanceTask: задачу на вопросе нельзя продвинуть кнопкой «Дальше»', async () => {
  const c = fakeClient([{
    re: /FROM tasks t LEFT JOIN roles r[\s\S]*FOR UPDATE OF t/,
    reply: {
      rowCount: 1,
      rows: [{
        id: 't1', status: 'NEEDS_INPUT', project_id: 'p1',
        assigned_agent_id: null, current_role_id: 'rProg', role_code: 'PROGRAMMER',
      }],
    },
  }]);
  await assert.rejects(() => advanceTaskTx(c, 't1'), /task_needs_input_use_answer/);
});
